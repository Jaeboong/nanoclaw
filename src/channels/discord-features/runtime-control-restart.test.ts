import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the restart primitive so we can assert /model and /effort invoke it
// (the live-apply behavior) without a real container runtime. `vi.hoisted`
// lets the mock factory (hoisted above imports) reference the spy.
const { restartMock } = vi.hoisted(() => ({
  restartMock: vi.fn((_agentGroupId: string, _reason: string, _wake?: string) => 0),
}));
vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: restartMock,
}));

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import type { SlashInvocation } from '../discord-interactions.js';
import { handleEffort, handleModel } from './runtime-control.js';

const PLATFORM_ID = 'discord:g1:c1';

function now(): string {
  return '2026-05-31T00:00:00.000Z';
}

function seedWiredChannel(): void {
  createAgentGroup({ id: 'ag-1', name: 'Test Group', folder: 'test-group', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: PLATFORM_ID,
    name: 'Test Channel',
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

function inv(options: Record<string, string>): SlashInvocation {
  return { platformId: PLATFORM_ID, userId: '42', options } as unknown as SlashInvocation;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  restartMock.mockClear();
  restartMock.mockReturnValue(0);
});

afterEach(() => {
  closeDb();
});

describe('/model live restart', () => {
  it('restarts the group container after persisting the model', async () => {
    seedWiredChannel();
    await handleModel(inv({ choice: 'claude-opus-4-8' }));
    expect(restartMock).toHaveBeenCalledWith('ag-1', 'Model changed via /model');
  });

  it('reports the restart count in the reply when a container was running', async () => {
    seedWiredChannel();
    restartMock.mockReturnValue(2);
    const res = await handleModel(inv({ choice: 'claude-opus-4-8' }));
    expect(res.text).toContain('재시작');
  });

  it('does not restart when only viewing current settings', async () => {
    seedWiredChannel();
    await handleModel(inv({}));
    expect(restartMock).not.toHaveBeenCalled();
  });
});

describe('/effort live restart', () => {
  it('restarts the group container after persisting the effort', async () => {
    seedWiredChannel();
    await handleEffort(inv({ level: 'xhigh' }));
    expect(restartMock).toHaveBeenCalledWith('ag-1', 'Effort changed via /effort');
  });
});
