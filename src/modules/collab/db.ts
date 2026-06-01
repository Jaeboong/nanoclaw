/**
 * Persistence for collab + responder state, keyed by `messaging_group_id`.
 *
 * Module-owned tables (see migrations/module-collab-state.ts). The DB handle
 * is the shared core connection (`getDb`), same as other module DB helpers
 * (cf. container-configs.ts) — no separate file.
 */
import { getDb } from '../../db/connection.js';
import type { CollabSession } from './state.js';
import { type Responder, isResponder } from './responder.js';

interface CollabSessionRow {
  messaging_group_id: string;
  session_id: string;
  task: string;
  starter: string;
  next_agent: string;
  max_rounds: number;
  round: number;
  done_claude: number;
  done_codex: number;
  status: string;
  started_by: string;
  started_at: string;
  updated_at: string;
  last_status: string | null;
  last_agent: string | null;
  ended_reason: string | null;
}

function isCollabAgentValue(v: string): v is CollabSession['starter'] {
  return v === 'claude' || v === 'codex';
}

function rowToSession(row: CollabSessionRow): CollabSession {
  const starter = isCollabAgentValue(row.starter) ? row.starter : 'claude';
  const nextAgent = isCollabAgentValue(row.next_agent) ? row.next_agent : starter;
  const status: CollabSession['status'] =
    row.status === 'active' ||
    row.status === 'complete' ||
    row.status === 'paused' ||
    row.status === 'blocked' ||
    row.status === 'stopped'
      ? row.status
      : 'active';
  const lastStatus =
    row.last_status === 'DONE' ||
    row.last_status === 'CONTINUE' ||
    row.last_status === 'NEEDS_USER' ||
    row.last_status === 'BLOCKED'
      ? row.last_status
      : undefined;
  const lastAgent =
    row.last_agent === 'claude' || row.last_agent === 'codex' ? row.last_agent : undefined;
  return {
    id: row.session_id,
    task: row.task,
    starter,
    nextAgent,
    maxRounds: row.max_rounds,
    round: row.round,
    done: { claude: row.done_claude === 1, codex: row.done_codex === 1 },
    status,
    startedBy: row.started_by,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(lastStatus ? { lastStatus } : {}),
    ...(lastAgent ? { lastAgent } : {}),
    ...(row.ended_reason ? { endedReason: row.ended_reason } : {}),
  };
}

export function getCollabSession(messagingGroupId: string): CollabSession | undefined {
  const row = getDb()
    .prepare('SELECT * FROM collab_sessions WHERE messaging_group_id = ?')
    .get(messagingGroupId) as CollabSessionRow | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getActiveCollabSession(messagingGroupId: string): CollabSession | undefined {
  const session = getCollabSession(messagingGroupId);
  return session?.status === 'active' ? session : undefined;
}

export function upsertCollabSession(messagingGroupId: string, session: CollabSession): void {
  getDb()
    .prepare(
      `INSERT INTO collab_sessions (
        messaging_group_id, session_id, task, starter, next_agent, max_rounds, round,
        done_claude, done_codex, status, started_by, started_at, updated_at,
        last_status, last_agent, ended_reason
      ) VALUES (
        @messaging_group_id, @session_id, @task, @starter, @next_agent, @max_rounds, @round,
        @done_claude, @done_codex, @status, @started_by, @started_at, @updated_at,
        @last_status, @last_agent, @ended_reason
      )
      ON CONFLICT(messaging_group_id) DO UPDATE SET
        session_id = excluded.session_id,
        task = excluded.task,
        starter = excluded.starter,
        next_agent = excluded.next_agent,
        max_rounds = excluded.max_rounds,
        round = excluded.round,
        done_claude = excluded.done_claude,
        done_codex = excluded.done_codex,
        status = excluded.status,
        started_by = excluded.started_by,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        last_status = excluded.last_status,
        last_agent = excluded.last_agent,
        ended_reason = excluded.ended_reason`,
    )
    .run({
      messaging_group_id: messagingGroupId,
      session_id: session.id,
      task: session.task,
      starter: session.starter,
      next_agent: session.nextAgent,
      max_rounds: session.maxRounds,
      round: session.round,
      done_claude: session.done.claude ? 1 : 0,
      done_codex: session.done.codex ? 1 : 0,
      status: session.status,
      started_by: session.startedBy,
      started_at: session.startedAt,
      updated_at: session.updatedAt,
      last_status: session.lastStatus ?? null,
      last_agent: session.lastAgent ?? null,
      ended_reason: session.endedReason ?? null,
    });
}

export function getResponder(messagingGroupId: string): Responder {
  const row = getDb()
    .prepare('SELECT responder FROM responder_state WHERE messaging_group_id = ?')
    .get(messagingGroupId) as { responder: string } | undefined;
  return row && isResponder(row.responder) ? row.responder : 'claude';
}

export function setResponder(
  messagingGroupId: string,
  responder: Responder,
  updatedBy: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO responder_state (messaging_group_id, responder, updated_by, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(messaging_group_id) DO UPDATE SET
         responder = excluded.responder,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(messagingGroupId, responder, updatedBy, new Date().toISOString());
}
