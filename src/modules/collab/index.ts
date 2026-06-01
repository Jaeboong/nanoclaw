/**
 * Collab + responder module — Discord 재붕봇(Claude)↔나붕봇(Codex) collaboration.
 *
 * Additive module (see docs/UPSTREAM-MERGE.md). Self-registers at import:
 *   - `/collab`, `/collab-stop`, `/responder` slash commands via the Task7
 *     interaction framework (`registerSlashCommand`).
 *   - A router interceptor via the additive `registerMessageInterceptor` seam.
 *
 * Turn-taking model (v2 idiom — the two bots are separate Discord identities,
 * so they hand off via channel messages):
 *
 *   - Claude's turn is *driven by the host*: we inject the framed turn prompt
 *     as a synthetic inbound message (id-prefixed `collab-inject-`) and let
 *     normal routing wake Claude's container. The framing is inbound (container
 *     input), so it never appears in the Discord channel.
 *   - Codex's turn is *observed*: 나붕봇 posts a reply ending with a
 *     `COLLAB_STATUS:` line; the interceptor records it.
 *   - "flip-on-dispatch": dispatching Claude's turn is modelled as an assumed
 *     `CONTINUE` (round++, next→codex) so round-counting and alternation stay
 *     correct *without observing Claude's own output*. Capturing Claude's own
 *     DONE/BLOCKED is a separate refinement (needs an outbound observer or a
 *     container-reported signal) — until then a Claude-initiated DONE just runs
 *     the session to max-rounds. Documented divergence (docs/UPSTREAM-MERGE.md).
 *
 * Accumulate gap: when the interceptor consumes a message (responder=codex, or
 * non-protocol chatter during Codex's turn) it returns true, so the message is
 * NOT stored as trigger=0 context. For collab this is benign (each agent sees
 * the preceding turn via the injected prompt). Recorded in the ledger.
 */
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { registerMessageInterceptor, routeInbound } from '../../router.js';
import {
  OPTION_STRING,
  registerSlashCommand,
  type SlashInvocation,
  type SlashResult,
} from '../../channels/discord-interactions.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup } from '../../types.js';

import {
  getActiveCollabSession,
  getCollabSession,
  getResponder,
  setResponder,
  upsertCollabSession,
} from './db.js';
import { isResponder } from './responder.js';
import {
  applyAgentTurn,
  buildCodexStarterHandoffMessage,
  buildCollabKickoffMessage,
  buildCollabTurnPrompt,
  createCollabSession,
  DEFAULT_MAX_ROUNDS,
  hasExplicitCollabTurnStatus,
  isCollabAgent,
  stopCollabSession,
  type CollabAgent,
  type CollabSession,
} from './state.js';

const NOT_WIRED = '이 채널은 NanoClaw 에이전트에 연결되어 있지 않습니다.';
const INJECT_PREFIX = 'collab-inject-';

interface ParsedContent {
  readonly text?: string;
  readonly senderId?: string;
}

function safeParseContent(raw: string): ParsedContent {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      text: typeof v.text === 'string' ? v.text : undefined,
      senderId: typeof v.senderId === 'string' ? v.senderId : undefined,
    };
  } catch {
    return { text: raw };
  }
}

function agentDisplayName(agent: CollabAgent): string {
  return agent === 'claude' ? '재붕봇' : '나붕봇';
}

function formatStartReply(starter: CollabAgent, maxRounds: number): string {
  const maxLabel = maxRounds === 0 ? 'until DONE' : String(maxRounds);
  return `Collab 시작. 시작 에이전트: ${agentDisplayName(starter)} · 최대 라운드: ${maxLabel}.`;
}

/**
 * Inject a framed collab prompt as a synthetic inbound message and let normal
 * routing deliver it to Claude's session and wake the container. Tagged with
 * `collab-inject-` so the interceptor skips it on re-entry.
 *
 * `senderId` is the session starter (an authorized admin) so the access gate
 * allows it — NOT the peer bot's id, which an `sender_scope='known'` wiring
 * could reject.
 */
async function injectCollabPrompt(params: {
  readonly platformId: string;
  readonly threadId: string | null;
  readonly senderId: string;
  readonly text: string;
}): Promise<void> {
  const event: InboundEvent = {
    channelType: 'discord',
    platformId: params.platformId,
    threadId: params.threadId,
    message: {
      id: `${INJECT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      content: JSON.stringify({
        text: params.text,
        sender: params.senderId,
        senderId: params.senderId,
      }),
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: params.threadId !== null,
    },
  };
  await routeInbound(event);
}

/**
 * Model Claude taking its turn: round++, flip next→codex (assumed CONTINUE),
 * persist, and inject the framed turn prompt. `conversation` is the text Claude
 * should act on (the kickoff text, or the peer bot's last turn).
 */
async function dispatchClaudeTurn(
  mg: MessagingGroup,
  platformId: string,
  threadId: string | null,
  claudeTurnSession: CollabSession,
  conversation: string,
  framedOverride?: string,
): Promise<void> {
  const dispatched = applyAgentTurn(claudeTurnSession, 'claude', 'COLLAB_STATUS: CONTINUE');
  const next = dispatched.session ?? claudeTurnSession;
  upsertCollabSession(mg.id, next);

  const prompt =
    framedOverride ??
    buildCollabTurnPrompt({
      agent: 'claude',
      task: next.task,
      round: next.round,
      maxRounds: next.maxRounds,
      conversation,
    });
  await injectCollabPrompt({ platformId, threadId, senderId: next.startedBy, text: prompt });
}

// ── Router interceptor ────────────────────────────────────────────────────

export async function collabInterceptor(event: InboundEvent): Promise<boolean> {
  // Collab/responder is Discord-specific; skip everything else cheaply.
  if (event.channelType !== 'discord') return false;
  // Never re-consume our own injected turn prompts.
  if (event.message.id.startsWith(INJECT_PREFIX)) return false;

  const mg = getMessagingGroupByPlatform('discord', event.platformId);
  if (!mg) return false;

  const { text = '' } = safeParseContent(event.message.content);
  const active = getActiveCollabSession(mg.id);

  if (active) {
    if (active.nextAgent === 'codex') {
      // Awaiting the peer bot's turn. Record it iff it carries a protocol line.
      if (hasExplicitCollabTurnStatus(text)) {
        const afterCodex = applyAgentTurn(active, 'codex', text);
        if (afterCodex.session) {
          if (afterCodex.session.status === 'active' && afterCodex.session.nextAgent === 'claude') {
            await dispatchClaudeTurn(mg, event.platformId, event.threadId, afterCodex.session, text);
          } else {
            upsertCollabSession(mg.id, afterCodex.session);
          }
          log.info('Collab codex turn recorded', {
            messagingGroupId: mg.id,
            reason: afterCodex.reason,
            status: afterCodex.session.status,
            nextAgent: afterCodex.session.nextAgent,
            round: afterCodex.session.round,
          });
        }
      }
      // Consume: protocol turn or stray chatter during Codex's turn — Claude
      // must not separately respond while it isn't its turn.
      return true;
    }
    // nextAgent === 'claude': transient (we drive Claude via injection). Suppress
    // any raw inbound so only the driven turn engages.
    return true;
  }

  // No active collab — apply the responder toggle.
  if (getResponder(mg.id) === 'codex') return true;
  return false;
}

registerMessageInterceptor(collabInterceptor);

// ── Slash commands ────────────────────────────────────────────────────────

async function handleCollab(inv: SlashInvocation): Promise<SlashResult> {
  const mg = getMessagingGroupByPlatform('discord', inv.platformId);
  if (!mg) return { text: NOT_WIRED };

  const task = (inv.options.task ?? '').trim();
  if (!task) return { text: 'Usage: /collab task:<자연어 작업>' };

  const starter: CollabAgent = isCollabAgent(inv.options.start) ? inv.options.start : 'claude';
  const maxRounds = inv.options.max !== undefined ? Number(inv.options.max) : DEFAULT_MAX_ROUNDS;

  const session = createCollabSession({ task, starter, startedBy: inv.userId, maxRounds });
  upsertCollabSession(mg.id, session);

  if (starter === 'claude') {
    // Drive Claude's first turn: kickoff framing as the conversation.
    await dispatchClaudeTurn(
      mg,
      inv.platformId,
      null,
      session,
      task,
      buildCollabKickoffMessage(session),
    );
  } else {
    // Codex starts: post a public handoff so 나붕봇 begins; next stays codex.
    const adapter = getDeliveryAdapter();
    if (adapter) {
      try {
        await adapter.deliver(
          'discord',
          inv.platformId,
          null,
          'chat',
          JSON.stringify({ text: buildCodexStarterHandoffMessage(session) }),
        );
      } catch (err) {
        log.error('Collab codex handoff failed', { messagingGroupId: mg.id, err });
      }
    }
  }

  return { text: formatStartReply(starter, session.maxRounds), ephemeral: false };
}

async function handleCollabStop(inv: SlashInvocation): Promise<SlashResult> {
  const mg = getMessagingGroupByPlatform('discord', inv.platformId);
  if (!mg) return { text: NOT_WIRED };
  const session = getCollabSession(mg.id);
  if (!session || session.status !== 'active') {
    return { text: '진행 중인 collab 세션이 없습니다.' };
  }
  upsertCollabSession(mg.id, stopCollabSession(session));
  log.info('Collab session stopped', { messagingGroupId: mg.id, sessionId: session.id });
  return { text: 'Collab 세션을 중단했습니다.' };
}

async function handleResponder(inv: SlashInvocation): Promise<SlashResult> {
  const mg = getMessagingGroupByPlatform('discord', inv.platformId);
  if (!mg) return { text: NOT_WIRED };
  const mode = inv.options.mode;
  if (mode === undefined) return { text: `현재 responder: **${getResponder(mg.id)}**` };
  if (!isResponder(mode)) return { text: 'Usage: /responder mode:[claude|codex|both]' };
  setResponder(mg.id, mode, inv.userId);
  return { text: `Responder 변경 → **${mode}**` };
}

registerSlashCommand(
  {
    name: 'collab',
    description: '재붕봇(Claude)↔나붕봇(Codex) 협업 세션 시작',
    requireAdmin: true,
    options: [
      { type: OPTION_STRING, name: 'task', description: '협업 작업(자연어)', required: true },
      {
        type: OPTION_STRING,
        name: 'start',
        description: '시작 에이전트 (기본: Claude)',
        required: false,
        choices: [
          { name: 'Claude', value: 'claude' },
          { name: 'Codex', value: 'codex' },
        ],
      },
      {
        type: OPTION_STRING,
        name: 'max',
        description: '최대 라운드 (0 = DONE까지 무제한, 기본 10)',
        required: false,
      },
    ],
  },
  handleCollab,
);

registerSlashCommand(
  {
    name: 'collab-stop',
    description: '이 채널의 진행 중인 collab 세션 중단',
    requireAdmin: true,
  },
  handleCollabStop,
);

registerSlashCommand(
  {
    name: 'responder',
    description: '이 채널의 응답 담당(Claude/Codex/Both) 확인·변경',
    requireAdmin: true,
    options: [
      {
        type: OPTION_STRING,
        name: 'mode',
        description: '응답 모드 (생략 시 현재 설정 조회)',
        required: false,
        choices: [
          { name: 'Claude', value: 'claude' },
          { name: 'Codex', value: 'codex' },
          { name: 'Both', value: 'both' },
        ],
      },
    ],
  },
  handleResponder,
);

export { handleCollab, handleCollabStop, handleResponder };
