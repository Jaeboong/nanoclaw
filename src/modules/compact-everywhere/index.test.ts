/**
 * /compact-everywhere — behaviour tests.
 *
 * Real DB layer (messaging groups / agents / sessions) so the load-bearing
 * `findSessionForAgent` resolution is exercised for real; only the I/O
 * boundaries are mocked — `registerSlashCommand` (to capture the def+handler),
 * `writeSessionMessage` (file I/O), and `wakeContainer` (spawns a container).
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SlashCommandDef,
  SlashHandler,
  SlashInvocation,
} from '../../channels/discord-interactions.js';

// Hoisted so the (hoisted) vi.mock factories can safely reference them even
// though `import './index.js'` below triggers the factories at load time.
const { registered, wakeContainerMock, writeSessionMessageMock } = vi.hoisted(() => ({
  registered: {} as { def?: SlashCommandDef; handler?: SlashHandler },
  wakeContainerMock: vi.fn(async (_session: import('../../types.js').Session) => true),
  writeSessionMessageMock: vi.fn(),
}));

// Capture the slash registration performed at module import.
vi.mock('../../channels/discord-interactions.js', () => ({
  registerSlashCommand: vi.fn((def: SlashCommandDef, handler: SlashHandler) => {
    registered.def = def;
    registered.handler = handler;
  }),
}));
vi.mock('../../container-runner.js', () => ({ wakeContainer: wakeContainerMock }));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: writeSessionMessageMock }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-compact' };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';

import './index.js'; // self-registers → fills `registered`

const TEST_DIR = '/tmp/nanoclaw-test-compact';
const PLATFORM = 'discord:g:c';

function now(): string {
  return new Date().toISOString();
}

function invocation(over: Partial<SlashInvocation> = {}): SlashInvocation {
  return {
    commandName: 'compact',
    options: {},
    userId: 'discord:admin',
    channelId: 'c',
    guildId: 'g',
    platformId: PLATFORM,
    ...over,
  };
}

function seedChannel(agents: string[]): void {
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: PLATFORM,
    name: 'Chan',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  agents.forEach((ag, i) => {
    createAgentGroup({ id: ag, name: ag, folder: ag, agent_provider: null, created_at: now() });
    createMessagingGroupAgent({
      id: `mga-${i}`,
      messaging_group_id: 'mg-1',
      agent_group_id: ag,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });
}

function liveSession(agentGroupId: string, id = `sess-${agentGroupId}`): Session {
  const s: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: 'claude',
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: now(),
  };
  createSession(s);
  return s;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  wakeContainerMock.mockClear();
  writeSessionMessageMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('/compact-everywhere registration', () => {
  it('registers a deferred, admin-gated /compact slash command', () => {
    expect(registered.def?.name).toBe('compact');
    expect(registered.def?.requireAdmin).toBe(true);
    expect(registered.def?.deferred).toBe(true);
    expect(typeof registered.handler).toBe('function');
  });
});

describe('/compact-everywhere handler', () => {
  it('injects /compact into a live channel-root session and wakes it', async () => {
    seedChannel(['ag-1']);
    const s = liveSession('ag-1');

    const res = await registered.handler!(invocation());

    expect(writeSessionMessageMock).toHaveBeenCalledTimes(1);
    const [agId, sessId, msg] = writeSessionMessageMock.mock.calls[0] as [
      string,
      string,
      { id: string; trigger: number; platformId: string; channelType: string; threadId: string | null; content: string },
    ];
    expect(agId).toBe('ag-1');
    expect(sessId).toBe(s.id);
    expect(msg.trigger).toBe(1);
    expect(msg.platformId).toBe(PLATFORM);
    expect(msg.channelType).toBe('discord');
    expect(msg.threadId).toBeNull();
    expect(msg.id.startsWith('compact-inject-')).toBe(true);
    expect(JSON.parse(msg.content)).toMatchObject({ text: '/compact', senderId: 'discord:admin' });

    expect(wakeContainerMock).toHaveBeenCalledTimes(1);
    expect(wakeContainerMock.mock.calls[0][0].id).toBe(s.id);
    expect(res.text).toContain('1개 세션');
  });

  it('informs and injects nothing when no live session exists (no resolveSession leak)', async () => {
    seedChannel(['ag-1']); // wired, but no session created
    const res = await registered.handler!(invocation());
    expect(writeSessionMessageMock).not.toHaveBeenCalled();
    expect(wakeContainerMock).not.toHaveBeenCalled();
    expect(res.text).toContain('압축할 컨텍스트가 없');
  });

  it('reports not-wired when the platformId resolves to no messaging group (e.g. a thread)', async () => {
    const res = await registered.handler!(invocation({ platformId: 'discord:g:thread-xyz' }));
    expect(writeSessionMessageMock).not.toHaveBeenCalled();
    expect(wakeContainerMock).not.toHaveBeenCalled();
    expect(res.text).toContain('연결돼 있지 않');
  });

  it('fans out across wired agents, skipping those without a live session', async () => {
    seedChannel(['ag-1', 'ag-2']);
    liveSession('ag-1', 'sess-1'); // ag-2 has no live session
    const res = await registered.handler!(invocation());
    expect(writeSessionMessageMock).toHaveBeenCalledTimes(1);
    expect(writeSessionMessageMock.mock.calls[0][0]).toBe('ag-1');
    expect(wakeContainerMock).toHaveBeenCalledTimes(1);
    expect(res.text).toContain('1개 세션');
  });

  it('compacts every wired agent that has a live session', async () => {
    seedChannel(['ag-1', 'ag-2']);
    liveSession('ag-1', 'sess-1');
    liveSession('ag-2', 'sess-2');
    const res = await registered.handler!(invocation());
    expect(writeSessionMessageMock).toHaveBeenCalledTimes(2);
    expect(wakeContainerMock).toHaveBeenCalledTimes(2);
    expect(res.text).toContain('2개 세션');
  });
});
