/**
 * Live tool status line — default module.
 *
 * While the agent is working, posts a single channel message and edits it
 * in place to show the tool currently in flight and how long it has been
 * running (e.g. "🔧 Bash · 12초"). Between tools it shows a neutral
 * "💭 작업 중…". The message is deleted when the turn ends, so the channel
 * is left with only the agent's real reply.
 *
 * Source of truth is what the container already maintains —
 * `container_state.current_tool` / `tool_started_at`, written by the
 * agent-runner's PreToolUse / PostToolUse hooks — so no extra container-side
 * signaling is needed. Display goes through the delivery adapter's existing
 * `deliver({ operation })` edit/delete path, so no adapter-interface change
 * is needed either.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core); ships on main.
 *   - Acquires the delivery adapter via `onDeliveryAdapterReady` — no edit to
 *     core `setDeliveryAdapter`.
 *   - `startStatusLine` / `stopStatusLine` are imported directly by
 *     `router.ts` and `container-runner.ts` at the same lifecycle points as
 *     the typing module. Removing requires dropping those calls.
 *
 * Complements (does not replace) the typing module: typing answers "is it
 * alive?", this answers "what is it doing?".
 */
import type Database from 'better-sqlite3';

import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { getContainerState, type ContainerState } from '../../db/session-db.js';
import { log } from '../../log.js';
import { openOutboundDb } from '../../session-manager.js';

/**
 * How often to re-read container_state and refresh the status line. The
 * first tick fires after this delay (not immediately), so turns shorter
 * than one interval never post a status message at all — no flicker.
 */
const STATUS_REFRESH_MS = 3000;

/** The delivery adapter's `kind` for chat-SDK-bridge messages. */
const DELIVER_KIND = 'chat-sdk';

interface StatusTarget {
  readonly agentGroupId: string;
  readonly channelType: string;
  readonly platformId: string;
  readonly threadId: string | null;
  readonly interval: NodeJS.Timeout;
  /** Platform message id once the status line has been posted. */
  messageId: string | null;
  /** Last text we set — skip redundant edits when nothing changed. */
  lastText: string | null;
  /** Guard so a slow post/edit can't overlap the next tick. */
  posting: boolean;
  /**
   * Set by stopStatusLine. If the turn ends while the very first post is
   * still in flight, the entry has no messageId yet so stop can't delete it
   * — the in-flight tick checks this on resolve and deletes the message it
   * just created, so nothing leaks.
   */
  stopped: boolean;
}

let adapter: ChannelDeliveryAdapter | null = null;
const refreshers = new Map<string, StatusTarget>();

/**
 * Bind the delivery adapter. Wired at boot via `onDeliveryAdapterReady` from
 * `./register` (barrel-only) so this module — imported directly by the router
 * for start/stopStatusLine — has no top-level dependency on a runtime
 * `delivery.js` export (keeps it import-safe under partial test mocks).
 */
export function setStatusLineAdapter(a: ChannelDeliveryAdapter): void {
  adapter = a;
}

/** Reads a session's container_state. Swappable in tests (the I/O boundary). */
type StateReader = (agentGroupId: string, sessionId: string) => ContainerState | null;

/** Render the status text for the current container tool state. */
export function formatStatus(state: ContainerState | null): string {
  if (!state || !state.current_tool) return '💭 작업 중…';
  const startedMs = state.tool_started_at ? new Date(state.tool_started_at).getTime() : NaN;
  const elapsedSec = Number.isFinite(startedMs) ? Math.max(0, Math.round((Date.now() - startedMs) / 1000)) : 0;
  return `🔧 ${state.current_tool} · ${elapsedSec}초`;
}

/**
 * Read the session's container_state from its outbound.db (read-only,
 * opened and closed per tick — mirrors the host sweep). Returns null when
 * the DB isn't present yet or no tool is in flight.
 */
function readContainerState(agentGroupId: string, sessionId: string): ContainerState | null {
  let db: Database.Database | null = null;
  try {
    db = openOutboundDb(agentGroupId, sessionId);
    return getContainerState(db);
  } catch {
    // outbound.db may not exist until the container's first write — treat
    // as "no tool in flight" and try again next tick.
    return null;
  } finally {
    db?.close();
  }
}

/** Active container-state reader — the real DB read, swapped in tests. */
let stateReader: StateReader = readContainerState;

/** Best-effort delete of a status message via the bridge's delete operation. */
async function deleteStatusMessage(entry: StatusTarget, messageId: string): Promise<void> {
  if (!adapter) return;
  try {
    await adapter.deliver(
      entry.channelType,
      entry.platformId,
      entry.threadId,
      DELIVER_KIND,
      JSON.stringify({ operation: 'delete', messageId }),
    );
  } catch (err) {
    log.warn('status-line: failed to delete status message', { err });
  }
}

async function tick(sessionId: string): Promise<void> {
  const entry = refreshers.get(sessionId);
  if (!entry || !adapter || entry.posting) return;

  const state = stateReader(entry.agentGroupId, sessionId);
  // Don't create a status message until the agent actually runs a tool —
  // the typing indicator already covers "is it alive". Once posted, keep
  // it updated (including the neutral line between tools).
  if (!entry.messageId && (!state || !state.current_tool)) return;

  const text = formatStatus(state);
  if (text === entry.lastText) return;

  entry.posting = true;
  try {
    if (!entry.messageId) {
      const id = await adapter.deliver(
        entry.channelType,
        entry.platformId,
        entry.threadId,
        DELIVER_KIND,
        JSON.stringify({ text }),
      );
      if (id && entry.stopped) {
        // The turn ended while this post was in flight; stopStatusLine
        // couldn't delete a message it didn't know about. Clean it up now
        // so it doesn't leak.
        await deleteStatusMessage(entry, id);
      } else if (id) {
        entry.messageId = id;
        entry.lastText = text;
      }
    } else {
      await adapter.deliver(
        entry.channelType,
        entry.platformId,
        entry.threadId,
        DELIVER_KIND,
        JSON.stringify({ operation: 'edit', messageId: entry.messageId, text }),
      );
      entry.lastText = text;
    }
  } catch (err) {
    log.warn('status-line: failed to post/edit status', { sessionId, err });
  } finally {
    entry.posting = false;
  }
}

/**
 * Begin tracking tool status for a session. Idempotent: a second call for a
 * session already being tracked is a no-op (the running refresher keeps its
 * posted message). Mirrors `startTypingRefresh`'s call site in the router.
 */
export function startStatusLine(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): void {
  if (refreshers.has(sessionId)) return;

  const interval = setInterval(() => {
    void tick(sessionId);
  }, STATUS_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();

  refreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    interval,
    messageId: null,
    lastText: null,
    posting: false,
    stopped: false,
  });
}

/**
 * Stop tracking a session and delete its status message (if any) so the
 * channel is left with just the agent's reply. Best-effort: a delete that
 * fails (e.g. message already gone) is logged, not thrown. Mirrors
 * `stopTypingRefresh`'s call sites in the router and container runner.
 */
export function stopStatusLine(sessionId: string): void {
  const entry = refreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  refreshers.delete(sessionId);
  // Mark stopped so a first-post still in flight deletes itself on resolve
  // (it has no messageId yet, so we can't delete it from here).
  entry.stopped = true;

  if (entry.messageId) {
    void deleteStatusMessage(entry, entry.messageId);
  }
}

/**
 * Test-only seam: drive a single refresh tick deterministically (no timers)
 * and swap the container-state reader (the I/O boundary). The delivery
 * adapter is bound through the real `onDeliveryAdapterReady` path, so tests
 * exercise the actual wiring.
 */
export const __testHooks = {
  setStateReader(fn: StateReader): void {
    stateReader = fn;
  },
  resetStateReader(): void {
    stateReader = readContainerState;
  },
  tick,
  isTracked(sessionId: string): boolean {
    return refreshers.has(sessionId);
  },
};
