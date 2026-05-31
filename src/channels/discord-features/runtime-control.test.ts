import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getContainerConfig,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { handleInteraction, listSlashCommandDefs, type RawDiscordInteraction } from '../discord-interactions.js';
// Side-effect import: registers /model and /effort into the interaction registry.
import './runtime-control.js';

interface RecordedCall {
  url: string;
  body: Record<string, unknown> | undefined;
}

function recordingFetch(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
    });
    return { ok: true, status: 200, json: async () => [], text: async () => '' } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function now(): string {
  return '2026-05-31T00:00:00.000Z';
}

const PLATFORM_ID = 'discord:g1:c1';

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

function modelInteraction(value?: string): RawDiscordInteraction {
  return {
    id: 'int-1',
    application_id: 'app-1',
    token: 'tok-1',
    type: 2,
    channel_id: 'c1',
    guild_id: 'g1',
    member: { user: { id: '42' } },
    data: { name: 'model', options: value === undefined ? [] : [{ name: 'choice', value }] },
  };
}

function effortInteraction(value?: string): RawDiscordInteraction {
  return {
    id: 'int-2',
    application_id: 'app-1',
    token: 'tok-2',
    type: 2,
    channel_id: 'c1',
    guild_id: 'g1',
    member: { user: { id: '42' } },
    data: { name: 'effort', options: value === undefined ? [] : [{ name: 'level', value }] },
  };
}

const admin = { isAdminImpl: () => true };

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

describe('runtime-control registration', () => {
  it('registers /model and /effort with static choices (no autocomplete)', () => {
    const names = listSlashCommandDefs().map((d) => d.name);
    expect(names).toContain('model');
    expect(names).toContain('effort');
    const model = listSlashCommandDefs().find((d) => d.name === 'model');
    expect(model?.requireAdmin).toBe(true);
    expect(model?.options?.[0].choices?.length).toBeGreaterThan(0);
  });
});

describe('/model', () => {
  it('persists the chosen model to container_configs', async () => {
    seedWiredChannel();
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(modelInteraction('claude-opus-4-8'), { fetchImpl, ...admin });

    expect(getContainerConfig('ag-1')?.model).toBe('claude-opus-4-8');
    expect(String((calls[0].body?.data as Record<string, unknown>).content)).toContain('Opus 4.8');
  });

  it('clears the model override when "default" is chosen', async () => {
    seedWiredChannel();
    const { fetchImpl } = recordingFetch();
    await handleInteraction(modelInteraction('claude-opus-4-8'), { fetchImpl, ...admin });
    expect(getContainerConfig('ag-1')?.model).toBe('claude-opus-4-8');

    await handleInteraction(modelInteraction('__default__'), { fetchImpl, ...admin });
    expect(getContainerConfig('ag-1')?.model).toBeNull();
  });

  it('shows current settings with no option and does not create a row', async () => {
    seedWiredChannel();
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(modelInteraction(undefined), { fetchImpl, ...admin });

    expect(getContainerConfig('ag-1')).toBeUndefined();
    expect(String((calls[0].body?.data as Record<string, unknown>).content)).toContain('현재');
  });

  it('replies that the channel is not wired when no agent group resolves', async () => {
    // No seed — channel resolves to nothing.
    const { fetchImpl, calls } = recordingFetch();
    await handleInteraction(modelInteraction('claude-opus-4-8'), { fetchImpl, ...admin });
    expect(String((calls[0].body?.data as Record<string, unknown>).content)).toContain('연결');
  });

  it('denies a non-admin and does not write config', async () => {
    seedWiredChannel();
    const { fetchImpl, calls } = recordingFetch();

    await handleInteraction(modelInteraction('claude-opus-4-8'), { fetchImpl, isAdminImpl: () => false });

    expect(getContainerConfig('ag-1')).toBeUndefined();
    expect(String((calls[0].body?.data as Record<string, unknown>).content)).toContain('권한');
  });
});

describe('/effort', () => {
  it('persists the chosen effort level', async () => {
    seedWiredChannel();
    const { fetchImpl } = recordingFetch();
    await handleInteraction(effortInteraction('xhigh'), { fetchImpl, ...admin });
    expect(getContainerConfig('ag-1')?.effort).toBe('xhigh');
  });

  it('clears effort when "off" is chosen', async () => {
    seedWiredChannel();
    const { fetchImpl } = recordingFetch();
    await handleInteraction(effortInteraction('high'), { fetchImpl, ...admin });
    expect(getContainerConfig('ag-1')?.effort).toBe('high');
    await handleInteraction(effortInteraction('off'), { fetchImpl, ...admin });
    expect(getContainerConfig('ag-1')?.effort).toBeNull();
  });
});
