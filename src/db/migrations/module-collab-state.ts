import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Collab + responder state for the collab module (Discord 재붕봇 ↔ 나붕봇
 * collaboration). Both tables are keyed by `messaging_group_id` — v2's channel
 * identity — replacing the v1 fork's JSON files keyed by `chatJid`.
 *
 * `collab_sessions` holds at most one (current) session per channel; a new
 * `/collab` replaces the row. `responder_state` holds the per-channel
 * answerer toggle. Added by the collab module; arbitrary version number per
 * the name-keyed migration scheme (see migrations/index.ts).
 */
export const moduleCollabState: Migration = {
  version: 16,
  name: 'collab-state',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE collab_sessions (
        messaging_group_id TEXT PRIMARY KEY REFERENCES messaging_groups(id),
        session_id   TEXT NOT NULL,
        task         TEXT NOT NULL,
        starter      TEXT NOT NULL,
        next_agent   TEXT NOT NULL,
        max_rounds   INTEGER NOT NULL,
        round        INTEGER NOT NULL,
        done_claude  INTEGER NOT NULL DEFAULT 0,
        done_codex   INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL,
        started_by   TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        last_status  TEXT,
        last_agent   TEXT,
        ended_reason TEXT
      );
      CREATE INDEX idx_collab_sessions_status ON collab_sessions(status);

      CREATE TABLE responder_state (
        messaging_group_id TEXT PRIMARY KEY REFERENCES messaging_groups(id),
        responder    TEXT NOT NULL,
        updated_by   TEXT,
        updated_at   TEXT
      );
    `);
  },
};
