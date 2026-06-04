/**
 * /compact-everywhere — uniform `/compact` across ALL channels.
 *
 * v2 natively dispatches `/compact` only where the message engages: is_main
 * channels (engage_mode pattern='.') and admin-gated typed commands. In the
 * mention/pattern sub-channels a bare typed `/compact` is dropped by
 * `evaluateEngage` before it ever reaches a session. This module captures
 * `/compact` as a Discord-native SLASH command — which is delivered over the
 * gateway-forward interaction path and NEVER touches `routeInbound` /
 * `evaluateEngage`, so engage_mode is irrelevant — and injects it straight
 * into the channel's LIVE session via the session-targeted path
 * (`writeSessionMessage` → `wakeContainer`), mirroring background-spawn and
 * agent-to-agent. The slash's `requireAdmin` flag IS the trust boundary:
 * `handleSlash` enforces `isAdmin` before the handler runs, and this path
 * deliberately bypasses `gateCommand` (which lives only in `deliverToAgent`).
 *
 * Additive: new module + 1 barrel import in src/modules/index.ts. Uses only
 * existing seams (`registerSlashCommand`, `findSessionForAgent`,
 * `writeSessionMessage`, `wakeContainer`). No core edit. See
 * docs/UPSTREAM-MERGE.md.
 *
 * Scope — channel ROOT only. A slash invoked inside a Discord thread carries
 * the thread id as `channel_id`, so `platformId` becomes `discord:{guild}:{
 * thread}`, which matches no messaging group → the command reports "not
 * wired". Full per-thread coverage would require extending the Task7
 * interaction shape to read `channel.parent_id` (a core seam touch beyond this
 * module's budget). Invoke `/compact` from the channel root.
 *
 * Non-native providers — `/compact` only compacts on a provider whose
 * container runner treats it as a native slash command (claude). A session on
 * a non-native provider degrades to a silent container-side no-op (the runner
 * wraps it as literal text). In this fork all wired agent sessions are Claude
 * (codex participates only as a collab peer, never as a wired session), so this
 * is not exercised; the count below still reflects sessions the command was
 * injected into.
 */
import {
  registerSlashCommand,
  type SlashInvocation,
  type SlashResult,
} from '../../channels/discord-interactions.js';
import { wakeContainer } from '../../container-runner.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { findSessionForAgent, getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

const NOT_WIRED = '이 채널은 에이전트에 연결돼 있지 않습니다. (채널 루트에서 실행했는지 확인하세요)';
const NO_SESSION = '이 채널에 진행 중인 세션이 없어 압축할 컨텍스트가 없습니다.';

function injectId(): string {
  return `compact-inject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Inject `/compact` into every LIVE channel-root session wired to the invoking
 * channel and wake its container. Returns an ephemeral confirmation.
 *
 * Authorization is already enforced by the framework: `requireAdmin: true`
 * makes `handleSlash` reject non-admins before this handler runs.
 */
export async function handleCompactEverywhere(inv: SlashInvocation): Promise<SlashResult> {
  const mg = getMessagingGroupByPlatform('discord', inv.platformId);
  if (!mg) return { text: NOT_WIRED };

  let compacted = 0;
  for (const agent of getMessagingGroupAgents(mg.id)) {
    // Channel ROOT session only (threadId=null), like collab. Non-creating:
    // `findSessionForAgent` (NOT `resolveSession`) so we never spin up an
    // empty session just to compact nothing.
    const session = findSessionForAgent(agent.agent_group_id, mg.id, null);
    if (!session) continue;

    writeSessionMessage(agent.agent_group_id, session.id, {
      id: injectId(),
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: session.thread_id,
      content: JSON.stringify({ text: '/compact', sender: inv.userId, senderId: inv.userId }),
      trigger: 1,
    });

    const fresh = getSession(session.id);
    if (fresh) await wakeContainer(fresh);
    compacted++;
    log.info('compact-everywhere injected /compact', {
      messagingGroupId: mg.id,
      agentGroupId: agent.agent_group_id,
      sessionId: session.id,
    });
  }

  if (compacted === 0) return { text: NO_SESSION };
  return { text: `컨텍스트 압축을 요청했습니다 (${compacted}개 세션). 곧 적용됩니다.` };
}

registerSlashCommand(
  {
    name: 'compact',
    description: '이 채널의 활성 세션 컨텍스트를 압축 (관리자 전용)',
    requireAdmin: true,
    // wakeContainer can cold-spawn a container — defer the ack (type 5) and
    // PATCH the confirmation so the 3s interaction window is never blown.
    deferred: true,
  },
  handleCompactEverywhere,
);
