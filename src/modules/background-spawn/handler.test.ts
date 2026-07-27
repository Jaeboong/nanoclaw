/**
 * Tests for the spawn_subagent host handler.
 *
 * Focuses on what the handler produces — the ephemeral worker session, the
 * injected task (origin routing), the container wake, the reap of finished
 * workers, and the guards. The end-to-end delivery of the worker's reply to the
 * origin channel is proven separately by spawn-pattern.test.ts.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const wakeMock = vi.fn(async (_s: unknown) => true);
vi.mock('../../container-runner.js', () => ({
  wakeContainer: (s: unknown) => wakeMock(s),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-bgspawn-handler' };
});

const TEST_DIR = '/tmp/nanoclaw-test-bgspawn-handler';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../../db/index.js';
import { createSession, getSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { inboundDbPath } from '../../session-manager.js';
import type { Session } from '../../types.js';

import { handleSpawnSubagent } from './handler.js';

const ORIGIN_PLATFORM = 'discord:g:c';

function now(): string {
  return new Date().toISOString();
}

function seed(): void {
  createAgentGroup({ id: 'ag-1', name: 'Parent', folder: 'parent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: ORIGIN_PLATFORM,
    name: 'Origin Chan',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
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

function parentSession(overrides: Partial<Session> = {}): Session {
  const s: Session = {
    id: 'parent-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: now(),
    ...overrides,
  };
  createSession(s);
  return s;
}

/** Read the rows injected into a worker session's inbound.db. */
function injectedRows(sessionId: string): Array<{ platform_id: string; channel_type: string; thread_id: string | null; content: string }> {
  const db = new Database(inboundDbPath('ag-1', sessionId));
  try {
    return db.prepare('SELECT platform_id, channel_type, thread_id, content FROM messages_in').all() as never;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  wakeMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleSpawnSubagent', () => {
  it('creates an isolated worker session and wakes it', async () => {
    seed();
    const parent = parentSession();

    await handleSpawnSubagent({ prompt: 'deploy the app' }, parent);

    expect(wakeMock).toHaveBeenCalledTimes(1);
    const worker = wakeMock.mock.calls[0][0] as Session;
    expect(worker.id.startsWith('bg-')).toBe(true);
    expect(worker.agent_group_id).toBe('ag-1'); // shares the parent's agent group
    expect(worker.messaging_group_id).toBeNull(); // never matched on a channel
    expect(worker.status).toBe('active');

    // Persisted, and distinct from the parent.
    expect(getSession(worker.id)?.id).toBe(worker.id);
    expect(worker.id).not.toBe(parent.id);
  });

  it('injects the task stamped with the origin channel + parent thread', async () => {
    seed();
    const parent = parentSession({ thread_id: 'thread-42' });

    await handleSpawnSubagent({ prompt: 'run the migration' }, parent);

    const worker = wakeMock.mock.calls[0][0] as Session;
    const rows = injectedRows(worker.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].platform_id).toBe(ORIGIN_PLATFORM);
    expect(rows[0].channel_type).toBe('discord');
    expect(rows[0].thread_id).toBe('thread-42'); // reply lands where the parent is
    expect(JSON.parse(rows[0].content).text).toBe('run the migration');
  });

  it('reaps a finished prior worker (container stopped) on the next spawn', async () => {
    seed();
    const parent = parentSession();

    // A prior worker whose container has already exited (old enough to reap —
    // past the boot-protection age guard).
    createSession({
      id: 'bg-old-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date(Date.now() - 120_000).toISOString(),
    });

    await handleSpawnSubagent({ prompt: 'another task' }, parent);

    expect(getSession('bg-old-1')?.status).toBe('closed');
    // The new worker is still active.
    const fresh = getSessionsByAgentGroup('ag-1').filter((s) => s.id.startsWith('bg-') && s.status === 'active');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).not.toBe('bg-old-1');
  });

  it('does not reap a worker whose container is still running', async () => {
    seed();
    const parent = parentSession();
    createSession({
      id: 'bg-running-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: now(),
    });

    await handleSpawnSubagent({ prompt: 'task' }, parent);
    expect(getSession('bg-running-1')?.status).toBe('active');
  });

  it('does not reap a freshly-spawned worker that is still booting (young + stopped)', async () => {
    seed();
    const parent = parentSession();
    // A sibling spawned moments ago: still stopped because wakeContainer hasn't
    // flipped it to running yet. The age guard must protect it.
    createSession({
      id: 'bg-booting-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    await handleSpawnSubagent({ prompt: 'task' }, parent);
    expect(getSession('bg-booting-1')?.status).toBe('active');
  });

  it('ignores an empty prompt', async () => {
    seed();
    const parent = parentSession();
    await handleSpawnSubagent({ prompt: '   ' }, parent);
    expect(wakeMock).not.toHaveBeenCalled();
  });

  it('ignores a parent session with no origin channel', async () => {
    seed();
    const parent = parentSession({ id: 'agent-sess', messaging_group_id: null });
    await handleSpawnSubagent({ prompt: 'deploy' }, parent);
    expect(wakeMock).not.toHaveBeenCalled();
  });
});
