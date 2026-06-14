/**
 * Agent activity snapshot — assembles "what is each agent doing right now"
 * from existing v2 state. There is no aggregate work-log table, so this is an
 * N+1 read over active sessions, gated on container liveness.
 *
 * CRITICAL liveness gate: `container_state` (the per-session current-tool row)
 * is cleared only by the agent-runner's PostToolUse hook on normal completion
 * — never on crash/kill, and the host never writes it. So a dead container
 * would show a phantom tool forever, and a freshly-woken one would show the
 * previous run's tool. We therefore read `getContainerState` ONLY when
 * `isContainerRunning(sessionId)` is true (the authoritative in-memory
 * liveness signal), and derive status from liveness + current_tool, NEVER from
 * the `container_status` column. Mirrors the status-line module's read pattern.
 */
import type Database from 'better-sqlite3';

import { isContainerRunning } from '../../container-runner.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getContainerState, type ContainerState } from '../../db/session-db.js';
import { getActiveSessions } from '../../db/sessions.js';
import { openOutboundDb } from '../../session-manager.js';

export type ActivityStatus = 'working' | 'thinking' | 'stopped';

export interface ActivityRow {
  readonly sessionId: string;
  readonly agentName: string;
  /** Originating chat (messaging group) name, when the session is wired to one. */
  readonly chat: string | null;
  readonly status: ActivityStatus;
  /** Tool in flight (working only); null otherwise. */
  readonly currentTool: string | null;
  /** Seconds the current tool has been running (working only); 0 otherwise. */
  readonly elapsedSec: number;
}

/** Reads a session's container_state. The swappable I/O boundary for tests. */
export type StateReader = (agentGroupId: string, sessionId: string) => ContainerState | null;

/**
 * Read the session's container_state from its outbound.db, read-only and
 * opened-and-closed per call (honors the cross-mount visibility invariant the
 * host sweep relies on). Returns null when the DB isn't present yet or no tool
 * is in flight.
 */
function readContainerState(agentGroupId: string, sessionId: string): ContainerState | null {
  let db: Database.Database | null = null;
  try {
    db = openOutboundDb(agentGroupId, sessionId);
    return getContainerState(db);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

let stateReader: StateReader = readContainerState;

/**
 * Build a snapshot of every active session and what it is doing right now.
 * Liveness-gated: a session whose container isn't running is reported
 * `stopped` and its (possibly stale) container_state is ignored.
 */
export function buildSnapshot(): readonly ActivityRow[] {
  return getActiveSessions().map((s): ActivityRow => {
    const live = isContainerRunning(s.id);
    let currentTool: string | null = null;
    let elapsedSec = 0;
    if (live) {
      const state = stateReader(s.agent_group_id, s.id);
      currentTool = state?.current_tool ?? null;
      if (state?.tool_started_at) {
        const startedMs = new Date(state.tool_started_at).getTime();
        if (Number.isFinite(startedMs)) {
          elapsedSec = Math.max(0, Math.round((Date.now() - startedMs) / 1000));
        }
      }
    }
    const ag = getAgentGroup(s.agent_group_id);
    const mg = s.messaging_group_id ? getMessagingGroup(s.messaging_group_id) : undefined;
    const status: ActivityStatus = !live ? 'stopped' : currentTool ? 'working' : 'thinking';
    return {
      sessionId: s.id,
      agentName: ag?.name ?? s.agent_group_id.slice(0, 8),
      chat: mg?.name ?? null,
      status,
      currentTool,
      elapsedSec,
    };
  });
}

/** Test-only seam: swap the container-state reader (the I/O boundary). */
export const __testHooks = {
  setStateReader(fn: StateReader): void {
    stateReader = fn;
  },
  resetStateReader(): void {
    stateReader = readContainerState;
  },
};
