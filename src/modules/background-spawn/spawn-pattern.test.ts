/**
 * Gating integration test for the background spawn_subagent PATTERN.
 *
 * Proves — BEFORE any module or container-tool code — that an ephemeral worker
 * session (agent_group = parent's, messaging_group_id = null, isolated context)
 * can deliver its reply to the ORIGIN channel root and pass the delivery ACL,
 * WITHOUT colliding with the parent's channel session.
 *
 * It exercises the real glue with no live container: createSession +
 * initSessionFolder + writeSessionMessage + a hand-written worker reply +
 * deliverSessionMessages. The three silent-failure points the design rests on
 * each get an assertion: (1) the worker never wins the channel's
 * findSessionForAgent lookup; (2) the worker's reply reaches the origin channel
 * root, authorized; (3) that authorization is load-bearing on the channel's
 * agent_destinations wiring row.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-bgspawn' };
});

const TEST_DIR = '/tmp/nanoclaw-test-bgspawn';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../../db/index.js';
import { createSession, findSessionForAgent, getActiveSessions, getRunningSessions } from '../../db/sessions.js';
import { initSessionFolder, outboundDbPath, writeSessionMessage } from '../../session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';

const ORIGIN_PLATFORM = 'discord:g:c';

function now(): string {
  return new Date().toISOString();
}

function seed(opts: { wire: boolean }): void {
  createAgentGroup({ id: 'ag-1', name: 'Parent Agent', folder: 'parent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: ORIGIN_PLATFORM,
    name: 'Origin Chan',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  if (opts.wire) {
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }
}

/** Simulate the future spawn_subagent host handler: create the ephemeral worker. */
function spawnWorker(prompt: string): Session {
  const bg: Session = {
    id: `bg-${Date.now()}-x`,
    agent_group_id: 'ag-1',
    messaging_group_id: null, // never matched by findSessionForAgent on a channel
    thread_id: null,
    agent_provider: null,
    status: 'active',
    // The real handler creates the worker 'stopped' and wakeContainer flips it
    // to 'running'; 'idle' here simulates that post-wake state so the active-poll
    // (getRunningSessions) assertion below also exercises. Delivery does not
    // depend on it: the 60s sweep uses getActiveSessions (status only).
    container_status: 'idle',
    last_active: null,
    created_at: now(),
  };
  createSession(bg);
  initSessionFolder('ag-1', bg.id); // creates inbound.db + outbound.db with schema
  // Inject the task as inbound, stamped with the ORIGIN routing and thread=null
  // so the worker's reply resolves to the channel root (resolveDestinationThread).
  writeSessionMessage('ag-1', bg.id, {
    id: 'inj-1',
    kind: 'chat',
    timestamp: now(),
    platformId: ORIGIN_PLATFORM,
    channelType: 'discord',
    threadId: null,
    content: JSON.stringify({ text: prompt, sender: 'system', senderId: 'system' }),
  });
  return bg;
}

/** Simulate the worker container writing its final reply to messages_out. */
function workerReply(sessionId: string, text: string, threadId: string | null = null): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, datetime('now'), 'chat', ?, 'discord', ?, ?)`,
  ).run('out-1', ORIGIN_PLATFORM, threadId, JSON.stringify({ text }));
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('background spawn pattern — ephemeral worker (messaging_group_id = null)', () => {
  it('does not collide with the parent channel session (findSessionForAgent)', () => {
    seed({ wire: true });
    const parent: Session = {
      id: 'parent-1',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: now(),
    };
    createSession(parent);
    spawnWorker('deploy the app'); // a second active session under ag-1, mg=null

    // The channel's inbound lookup must still resolve to the parent, never the worker.
    const resolved = findSessionForAgent('ag-1', 'mg-1', null);
    expect(resolved?.id).toBe('parent-1');
  });

  it('delivers the worker reply to the origin channel root, authorized via wiring', async () => {
    seed({ wire: true });
    const bg = spawnWorker('deploy the app');

    // (1) Poll inclusion — the sweep (status=active) and active poll
    //     (container_status idle/running) must both see the worker session.
    expect(getActiveSessions().map((s) => s.id)).toContain(bg.id);
    expect(getRunningSessions().map((s) => s.id)).toContain(bg.id);

    workerReply(bg.id, 'deploy done');

    const calls: Array<{ ct: string; pid: string; tid: string | null }> = [];
    setDeliveryAdapter({
      async deliver(ct, pid, tid) {
        calls.push({ ct, pid, tid });
        return 'pm-1';
      },
    });

    await deliverSessionMessages(bg);

    // (2) Authorized delivery to the ORIGIN channel ROOT (thread null).
    expect(calls).toEqual([{ ct: 'discord', pid: ORIGIN_PLATFORM, tid: null }]);
  });

  it('is idempotent — a re-drain does not re-post the worker reply', async () => {
    seed({ wire: true });
    const bg = spawnWorker('deploy the app');
    workerReply(bg.id, 'deploy done');

    let count = 0;
    setDeliveryAdapter({
      async deliver() {
        count++;
        return 'pm-1';
      },
    });

    await deliverSessionMessages(bg);
    await deliverSessionMessages(bg); // sweep re-visits the still-active session
    expect(count).toBe(1);
  });

  it('without channel wiring the ACL blocks delivery (the wiring row is load-bearing)', async () => {
    seed({ wire: false }); // no agent_destinations row for the origin channel
    const bg = spawnWorker('deploy the app');
    workerReply(bg.id, 'deploy done');

    const calls: unknown[] = [];
    setDeliveryAdapter({
      async deliver(ct, pid, tid) {
        calls.push({ ct, pid, tid });
        return 'pm';
      },
    });

    // Exhaust retries — the ACL throws before the adapter on every attempt.
    await deliverSessionMessages(bg);
    await deliverSessionMessages(bg);
    await deliverSessionMessages(bg);
    expect(calls).toHaveLength(0);
  });
});
