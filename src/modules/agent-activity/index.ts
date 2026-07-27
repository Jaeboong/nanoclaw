/**
 * /agents — interactive agent-activity panel.
 *
 * Posts a Discord panel listing which agent sessions are live and what tool
 * each is running right now. This is the FIRST consumer of the Task7
 * `registerComponentHandler` seam: the panel carries two callback buttons
 * (Refresh, Details) that route through the gateway-forward interaction path
 * (never `routeInbound` / `evaluateEngage`).
 *
 * Delivery shape (verified against @chat-adapter/discord@4.26.0): a card always
 * renders as message content (the card's fallback text) + an embed + a
 * component action row. `ComponentResult.update` can only PATCH the message
 * `content`, not the embed — so a button cannot refresh the embed in place
 * without a second core seam (extend ComponentResult to carry an embed
 * payload). We therefore keep the PUBLIC card a compact at-post-time summary
 * (header + counts), and the buttons deliver the live per-session detail as
 * EPHEMERAL followups (plain content — no embed, no duplication, no stale
 * board). Re-run /agents to refresh the public summary. A live in-place public
 * board is deferred to a future task that owns the embed-update seam.
 *
 * Authorization: the panel aggregates session activity across ALL agent groups
 * (`getActiveSessions` is global), so it is restricted to a GLOBAL owner/admin —
 * every entry point checks `isAdmin(userId, null)` (a `user_roles` row with
 * `agent_group_id IS NULL`). `requireAdmin` on the slash is a framework
 * pre-filter (channel-scoped); the explicit null-gate in each handler is
 * authoritative and also covers the component handlers, which the framework
 * leaves UNGATED (the known Task7 gap). A channel-scoped admin is therefore
 * denied — this is a global ops view, not a per-channel one. When the
 * permissions module isn't installed, `isAdmin` allows all (the fork-wide
 * stance).
 *
 * Additive: new module + 1 barrel import in src/modules/index.ts, plus the one
 * generic bridge-card-action seam (callback buttons on cards). See
 * docs/UPSTREAM-MERGE.md.
 */
import {
  registerComponentHandler,
  registerSlashCommand,
  type ComponentInvocation,
  type ComponentResult,
  type SlashInvocation,
  type SlashResult,
} from '../../channels/discord-interactions.js';
import { isAdmin } from '../../command-gate.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';

import { renderDetails, renderPanel, renderSummary } from './render.js';
import { buildSnapshot } from './snapshot.js';

/** The delivery adapter's `kind` for chat-SDK-bridge messages. */
const DELIVER_KIND = 'chat-sdk';
const PANEL_TITLE = '🛰️ 에이전트 활동';
const REFRESH_ID = 'work:refresh';
const DETAILS_ID = 'work:details';

const NO_ADAPTER = '지금은 패널을 게시할 수 없습니다. 잠시 후 다시 시도해주세요.';
const NOT_ADMIN = '전역 관리자 전용입니다.';
const PANEL_POSTED = '에이전트 활동 패널을 게시했습니다.';

/** The public panel: a compact summary card with two callback buttons. */
function panelContent(): string {
  return JSON.stringify({
    type: 'card',
    card: {
      title: PANEL_TITLE,
      children: [renderSummary(buildSnapshot())],
      actions: [
        { id: REFRESH_ID, label: '새로고침' },
        { id: DETAILS_ID, label: '상세' },
      ],
    },
  });
}

/** Slash handler — posts the public panel, acks the caller ephemerally. */
export async function handleAgentsPanel(inv: SlashInvocation): Promise<SlashResult> {
  if (!isAdmin(inv.userId, null)) return { text: NOT_ADMIN };
  const adapter = getDeliveryAdapter();
  if (!adapter) return { text: NO_ADAPTER };
  await adapter.deliver('discord', inv.platformId, null, DELIVER_KIND, panelContent());
  log.info('agent-activity: panel posted', { platformId: inv.platformId, by: inv.userId });
  return { text: PANEL_POSTED };
}

/** Refresh button — fresh compact snapshot, private to the clicker. */
export async function handleRefresh(inv: ComponentInvocation): Promise<ComponentResult> {
  if (!isAdmin(inv.userId, null)) {
    return { message: { text: NOT_ADMIN } };
  }
  return { message: { text: renderPanel(buildSnapshot()) } };
}

/** Details button — fresh per-session detail, private to the clicker. */
export async function handleDetails(inv: ComponentInvocation): Promise<ComponentResult> {
  if (!isAdmin(inv.userId, null)) {
    return { message: { text: NOT_ADMIN } };
  }
  const pages = renderDetails(buildSnapshot());
  if (pages.length === 0) return { message: { text: '활성 세션이 없습니다.' } };
  const extra = pages.length > 1 ? `\n\n…(외 ${pages.length - 1}페이지 생략, 🔄 새로고침)` : '';
  return { message: { text: pages[0] + extra } };
}

registerSlashCommand(
  {
    name: 'agents',
    description: '에이전트 활동 패널 게시 (관리자 전용)',
    requireAdmin: true,
    // The handler posts the panel via deliver() (network I/O) before returning;
    // defer the ack (type 5) so that never blows the 3s interaction window.
    deferred: true,
  },
  handleAgentsPanel,
);
registerComponentHandler(REFRESH_ID, handleRefresh);
registerComponentHandler(DETAILS_ID, handleDetails);
