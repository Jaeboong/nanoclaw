/**
 * /agents agent-activity panel — behaviour tests.
 *
 * Real DB layer (agent groups / messaging groups / sessions / user_roles) so
 * the snapshot assembly and the `isAdmin` self-gate run for real; only the I/O
 * boundaries are mocked — the interaction registry (capture def/handlers), the
 * delivery adapter (`getDeliveryAdapter`), container liveness
 * (`isContainerRunning`), and `openOutboundDb` (the container_state reader is
 * swapped via the snapshot test hook instead). No assertion touches Discord's
 * rendered output — only the payload/return shapes the module controls.
 */
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ComponentHandler,
  ComponentInvocation,
  SlashCommandDef,
  SlashHandler,
  SlashInvocation,
} from '../../channels/discord-interactions.js';

const { slash, components, deliverMock, isContainerRunningMock } = vi.hoisted(() => ({
  slash: {} as { def?: SlashCommandDef; handler?: SlashHandler },
  components: new Map<string, ComponentHandler>(),
  deliverMock: vi.fn(
    async (
      _ct: string,
      _pid: string,
      _tid: string | null,
      _kind: string,
      _content: string,
    ): Promise<string | undefined> => 'panel-msg',
  ),
  isContainerRunningMock: vi.fn((_id: string) => false),
}));

vi.mock('../../channels/discord-interactions.js', () => ({
  registerSlashCommand: vi.fn((def: SlashCommandDef, handler: SlashHandler) => {
    slash.def = def;
    slash.handler = handler;
  }),
  registerComponentHandler: vi.fn((prefix: string, handler: ComponentHandler) => {
    components.set(prefix, handler);
  }),
}));
vi.mock('../../container-runner.js', () => ({ isContainerRunning: isContainerRunningMock }));
vi.mock('../../delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver: deliverMock }) }));
vi.mock('../../session-manager.js', () => ({ openOutboundDb: vi.fn() }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-activity' };
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
import type { ContainerState } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';

import { handleAgentsPanel, handleDetails, handleRefresh } from './index.js';
import { renderDetails, renderPanel, renderSummary } from './render.js';
import { buildSnapshot, __testHooks, type ActivityRow } from './snapshot.js';

const TEST_DIR = '/tmp/nanoclaw-test-activity';
const PLATFORM = 'discord:g:c';

function now(): string {
  return new Date().toISOString();
}

function slashInv(over: Partial<SlashInvocation> = {}): SlashInvocation {
  return {
    commandName: 'agents',
    options: {},
    userId: 'discord:admin',
    channelId: 'c',
    guildId: 'g',
    platformId: PLATFORM,
    ...over,
  };
}

function componentInv(customId: string, over: Partial<ComponentInvocation> = {}): ComponentInvocation {
  return {
    customId,
    values: [],
    userId: 'discord:admin',
    channelId: 'c',
    guildId: 'g',
    platformId: PLATFORM,
    messageId: 'panel-msg',
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
    createAgentGroup({ id: ag, name: `에이전트-${ag}`, folder: ag, agent_provider: null, created_at: now() });
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

/** `null` agentGroupId = global owner; else scoped admin. */
function seedAdmin(userId: string, agentGroupId: string | null): void {
  upsertUser({ id: userId, kind: 'discord', display_name: userId, created_at: now() });
  grantRole({
    user_id: userId,
    role: agentGroupId === null ? 'owner' : 'admin',
    agent_group_id: agentGroupId,
    granted_by: null,
    granted_at: now(),
  });
}

function activeSession(agentGroupId: string, id: string): Session {
  const s: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: 'claude',
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: now(),
  };
  createSession(s);
  return s;
}

function state(tool: string | null, startedSecAgo = 0): ContainerState {
  return {
    current_tool: tool,
    tool_declared_timeout_ms: null,
    tool_started_at: tool ? new Date(Date.now() - startedSecAgo * 1000).toISOString() : null,
  };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  seedAdmin('discord:admin', null); // global owner — passes every self-gate
  deliverMock.mockClear();
  isContainerRunningMock.mockReset();
  isContainerRunningMock.mockReturnValue(false);
  __testHooks.resetStateReader();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('/agents registration', () => {
  it('registers an admin-gated, deferred /agents slash and two component handlers', () => {
    expect(slash.def?.name).toBe('agents');
    expect(slash.def?.requireAdmin).toBe(true);
    expect(slash.def?.deferred).toBe(true);
    expect(typeof slash.handler).toBe('function');
    expect(components.has('work:refresh')).toBe(true);
    expect(components.has('work:details')).toBe(true);
    // custom_ids must not collide with the reserved ask_question prefix.
    for (const id of components.keys()) expect(id.startsWith('ncq:')).toBe(false);
  });
});

describe('handleAgentsPanel (slash)', () => {
  it('posts a card carrying the two callback buttons and acks ephemerally', async () => {
    seedChannel(['ag-1']);
    const res = await handleAgentsPanel(slashInv());

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [ct, pid, tid, kind, content] = deliverMock.mock.calls[0];
    expect(ct).toBe('discord');
    expect(pid).toBe(PLATFORM);
    expect(tid).toBeNull();
    expect(kind).toBe('chat-sdk');

    const payload = JSON.parse(content) as {
      type: string;
      card: { title: string; actions: Array<{ id: string; label: string }> };
    };
    expect(payload.type).toBe('card');
    expect(payload.card.actions.map((a) => a.id)).toEqual(['work:refresh', 'work:details']);
    expect(res.text).toContain('패널을 게시');
  });
});

describe('component handlers', () => {
  it('Refresh returns an ephemeral fresh snapshot (no panel edit) for an admin', async () => {
    seedChannel(['ag-1']);
    activeSession('ag-1', 'sess-1');
    isContainerRunningMock.mockImplementation((id) => id === 'sess-1');
    __testHooks.setStateReader(() => state('Bash', 5));

    const res = await handleRefresh(componentInv('work:refresh'));

    expect(res.update).toBeUndefined(); // panel message is never PATCHed
    expect(res.message?.text).toContain('에이전트-ag-1');
    expect(res.message?.text).toContain('Bash');
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('Refresh denies a non-admin (ephemeral), reads nothing', async () => {
    seedChannel(['ag-1']);
    activeSession('ag-1', 'sess-1');
    const res = await handleRefresh(componentInv('work:refresh', { userId: 'discord:rando' }));
    expect(res.message?.text).toBe('관리자 전용입니다.');
    expect(res.update).toBeUndefined();
  });

  it('Details returns an ephemeral per-session detail for an admin', async () => {
    seedChannel(['ag-1']);
    activeSession('ag-1', 'sess-1');
    isContainerRunningMock.mockImplementation((id) => id === 'sess-1');
    __testHooks.setStateReader(() => state('Read', 2));

    const res = await handleDetails(componentInv('work:details'));
    expect(res.message?.text).toContain('에이전트-ag-1');
    expect(res.message?.text).toContain('sess-1');
  });

  it('Details denies a non-admin', async () => {
    const res = await handleDetails(componentInv('work:details', { userId: 'discord:rando' }));
    expect(res.message?.text).toBe('관리자 전용입니다.');
  });
});

describe('buildSnapshot — liveness gating', () => {
  it('reports a live session as working and ignores a dead session’s stale tool', async () => {
    seedChannel(['ag-1', 'ag-2']);
    activeSession('ag-1', 'sess-live');
    activeSession('ag-2', 'sess-dead');
    isContainerRunningMock.mockImplementation((id) => id === 'sess-live');
    // Both have a stale tool row, but the dead one must be ignored.
    __testHooks.setStateReader(() => state('Bash', 12));

    const rows = buildSnapshot();
    const live = rows.find((r) => r.sessionId === 'sess-live');
    const dead = rows.find((r) => r.sessionId === 'sess-dead');

    expect(live?.status).toBe('working');
    expect(live?.currentTool).toBe('Bash');
    expect(live?.elapsedSec).toBeGreaterThanOrEqual(11);
    expect(dead?.status).toBe('stopped');
    expect(dead?.currentTool).toBeNull(); // stale container_state NOT read for a dead container
  });

  it('reports a live session with no tool in flight as thinking', () => {
    seedChannel(['ag-1']);
    activeSession('ag-1', 'sess-1');
    isContainerRunningMock.mockReturnValue(true);
    __testHooks.setStateReader(() => state(null));

    const rows = buildSnapshot();
    expect(rows[0]?.status).toBe('thinking');
    expect(rows[0]?.currentTool).toBeNull();
    expect(rows[0]?.chat).toBe('Chan');
    expect(rows[0]?.agentName).toBe('에이전트-ag-1');
  });
});

describe('renderers (pure)', () => {
  function row(over: Partial<ActivityRow>): ActivityRow {
    return {
      sessionId: 's',
      agentName: 'A',
      chat: 'C',
      status: 'thinking',
      currentTool: null,
      elapsedSec: 0,
      ...over,
    };
  }

  it('renderSummary: empty vs counts', () => {
    expect(renderSummary([])).toBe('활성 세션이 없습니다.');
    const s = renderSummary([
      row({ status: 'working', currentTool: 'Bash', elapsedSec: 3 }),
      row({ status: 'stopped' }),
    ]);
    expect(s).toContain('활성 2');
    expect(s).toContain('작업 1');
    expect(s).toContain('중지 1');
  });

  it('renderPanel: clamps to under the Discord content cap and notes overflow', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      row({ sessionId: `s${i}`, agentName: `에이전트번호${i}`, status: 'working', currentTool: 'Bash', elapsedSec: i }),
    );
    const out = renderPanel(many);
    expect(out.length).toBeLessThanOrEqual(1900);
    expect(out).toContain('외');
  });

  it('renderDetails: empty is no pages; multi-row packs into pages', () => {
    expect(renderDetails([])).toEqual([]);
    const pages = renderDetails([row({ sessionId: 'x', status: 'working', currentTool: 'Read', elapsedSec: 1 })]);
    expect(pages.length).toBe(1);
    expect(pages[0]).toContain('세션');
    expect(pages[0]).toContain('x');
  });
});
