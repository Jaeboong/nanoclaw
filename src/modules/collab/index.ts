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
 *   - Claude's turn is *recorded from its own output*: when Claude's reply is
 *     delivered, the outbound observer (observeClaudeTurn, via the additive
 *     `registerOutboundObserver` seam) parses its real `COLLAB_STATUS` and
 *     advances/completes/blocks the session. This mirrors v1's
 *     recordClaudeCollabTurnIfNeeded — a Claude-initiated DONE/BLOCKED ends the
 *     session faithfully (no assumed-CONTINUE).
 *   - Codex's turn is *observed* on inbound: 나붕봇 posts a reply ending with a
 *     `COLLAB_STATUS:` line; the interceptor records it (is-bot guarded, per
 *     v1's is_bot_message).
 *
 * Peer-bot ingestion depends on the Chat SDK's webhook-forward gateway mode
 * (v2's default): the SDK filters only `isMe` (self), so the peer bot's
 * messages reach this interceptor while Claude's own output does not loop back
 * as inbound (it's recorded via the outbound observer instead). The legacy
 * gateway path would drop all bot messages — collab requires webhook-forward.
 *
 * Accumulate gap: when the interceptor consumes a message (responder=codex, or
 * non-protocol chatter during Codex's turn) it returns true, so the message is
 * NOT stored as trigger=0 context. For collab this is benign (each agent sees
 * the preceding turn via the injected prompt). Recorded in the ledger.
 */
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getDeliveryAdapter, registerOutboundObserver, type OutboundObservation } from '../../delivery.js';
import { log } from '../../log.js';
import { registerMessageInterceptor, routeInbound } from '../../router.js';
import {
  OPTION_STRING,
  registerSlashCommand,
  type SlashInvocation,
  type SlashResult,
} from '../../channels/discord-interactions.js';
import type { InboundEvent } from '../../channels/adapter.js';

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
  /** Whether the message is from a bot, e.g. the peer 나붕봇. Nested under
   *  `author` by the Chat SDK serialization (toJSON), NOT projected to the
   *  top level the way senderId is — read it from `author.isBot`. */
  readonly isBot?: boolean;
}

function safeParseContent(raw: string): ParsedContent {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const author = v.author as Record<string, unknown> | undefined;
    return {
      text: typeof v.text === 'string' ? v.text : undefined,
      senderId: typeof v.senderId === 'string' ? v.senderId : undefined,
      isBot: typeof author?.isBot === 'boolean' ? author.isBot : undefined,
    };
  } catch {
    return { text: raw };
  }
}

/**
 * Extract the deliverable body from an outbound message's content. Mirrors the
 * bridge's `deliver()` (chat-sdk-bridge.ts): `markdown || text`. The agent
 * runner writes `{ text: body }`; the `markdown` fallback covers other paths.
 */
function extractOutboundText(rawContent: string): string {
  try {
    const v = JSON.parse(rawContent) as Record<string, unknown>;
    if (typeof v.markdown === 'string') return v.markdown;
    if (typeof v.text === 'string') return v.text;
    return '';
  } catch {
    return '';
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
 * Dispatch Claude's turn by injecting the framed turn prompt. Does NOT record
 * the turn — Claude's actual turn (and its DONE/BLOCKED) is recorded later by
 * the outbound observer when Claude's reply is delivered (see observeClaudeTurn).
 * This mirrors v1, which records Claude's turn from its own output, not at
 * dispatch time. `conversation` is the text Claude should act on (the kickoff
 * text, or the peer bot's last turn). The prompt frames the *upcoming* round
 * (`round + 1`) without mutating state.
 */
async function dispatchClaudeTurn(
  platformId: string,
  threadId: string | null,
  session: CollabSession,
  conversation: string,
  framedOverride?: string,
): Promise<void> {
  const prompt =
    framedOverride ??
    buildCollabTurnPrompt({
      agent: 'claude',
      task: session.task,
      round: session.round + 1,
      maxRounds: session.maxRounds,
      conversation,
    });
  await injectCollabPrompt({ platformId, threadId, senderId: session.startedBy, text: prompt });
}

// ── Router interceptor ────────────────────────────────────────────────────

export async function collabInterceptor(event: InboundEvent): Promise<boolean> {
  // Collab/responder is Discord-specific; skip everything else cheaply.
  if (event.channelType !== 'discord') return false;
  // Never re-consume our own injected turn prompts.
  if (event.message.id.startsWith(INJECT_PREFIX)) return false;

  const mg = getMessagingGroupByPlatform('discord', event.platformId);
  if (!mg) return false;

  const { text = '', isBot } = safeParseContent(event.message.content);
  const active = getActiveCollabSession(mg.id);

  if (active) {
    if (active.nextAgent === 'codex') {
      // Record the peer bot's turn iff it's a bot message (나붕봇) carrying a
      // protocol line. The is-bot guard matches v1's is_bot_message check: a
      // human typing a COLLAB_STATUS line during Codex's turn must not count.
      if (isBot && hasExplicitCollabTurnStatus(text)) {
        const afterCodex = applyAgentTurn(active, 'codex', text);
        if (afterCodex.session) {
          upsertCollabSession(mg.id, afterCodex.session);
          if (afterCodex.session.status === 'active' && afterCodex.session.nextAgent === 'claude') {
            await dispatchClaudeTurn(event.platformId, event.threadId, afterCodex.session, text);
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
    // nextAgent === 'claude': Claude is driven by injection and its turn is
    // recorded from its own delivered output (observeClaudeTurn). Suppress raw
    // inbound so only the driven turn engages.
    return true;
  }

  // No active collab — apply the responder toggle.
  if (getResponder(mg.id) === 'codex') return true;
  return false;
}

registerMessageInterceptor(collabInterceptor);

// ── Outbound observer: record Claude's own turn from its delivered reply ────

/**
 * Record Claude's collab turn from its own delivered output — the v2 analogue
 * of v1's `recordClaudeCollabTurnIfNeeded` (which observed the container's
 * outbound stream). Fired by the delivery layer after Claude's reply lands.
 *
 * Guarded on an explicit `COLLAB_STATUS` line: the agent writes one
 * messages_out row per `<message to="">` block, so a turn can span multiple
 * rows — recording the status-bearing row (rather than blindly defaulting the
 * first row to CONTINUE) keeps a late DONE/BLOCKED from being missed. If Claude
 * omits the protocol line entirely the turn won't auto-record and the session
 * waits on Claude's turn; the turn prompt mandates exactly one such line.
 *
 * Runs synchronously (better-sqlite3): the `nextAgent` flip commits before this
 * delivery returns. The peer bot's reply is causally later — 나붕봇 can't post it
 * until Claude's message has been delivered to Discord — so by the time that
 * reply routes inbound, this flip is already committed and visible.
 */
export function observeClaudeTurn(msg: OutboundObservation): void {
  if (msg.channelType !== 'discord') return;
  const mg = getMessagingGroupByPlatform('discord', msg.platformId);
  if (!mg) return;
  const session = getActiveCollabSession(mg.id);
  if (!session || session.nextAgent !== 'claude') return;
  const text = extractOutboundText(msg.content);
  if (!text || !hasExplicitCollabTurnStatus(text)) return;
  const result = applyAgentTurn(session, 'claude', text);
  if (!result.session) return;
  upsertCollabSession(mg.id, result.session);
  log.info('Collab claude turn recorded', {
    messagingGroupId: mg.id,
    reason: result.reason,
    status: result.session.status,
    nextAgent: result.session.nextAgent,
    round: result.session.round,
  });
}

registerOutboundObserver(observeClaudeTurn);

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
