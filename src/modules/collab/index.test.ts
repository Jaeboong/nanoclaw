import fs from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';

const routeInboundMock = vi.fn(async (_event: InboundEvent) => {});
vi.mock('../../router.js', () => ({
  registerMessageInterceptor: vi.fn(),
  routeInbound: routeInboundMock,
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';

import {
  getActiveCollabSession,
  getCollabSession,
  getResponder,
  setResponder,
  upsertCollabSession,
} from './db.js';
import { createCollabSession, type CollabSession } from './state.js';

const TEST_DIR = '/tmp/nanoclaw-test-collab';
const PLATFORM = 'discord:g:c';
const MG = 'mg-1';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let collabInterceptor: (event: InboundEvent) => Promise<boolean>;

function now() {
  return new Date().toISOString();
}

function discordEvent(text: string, opts: { id?: string; senderId?: string } = {}): InboundEvent {
  return {
    channelType: 'discord',
    platformId: PLATFORM,
    threadId: null,
    message: {
      id: opts.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat-sdk',
      content: JSON.stringify({ text, senderId: opts.senderId ?? 'discord:peer' }),
      timestamp: now(),
    },
  };
}

function seedSession(overrides: Partial<CollabSession> = {}): CollabSession {
  const s: CollabSession = {
    ...createCollabSession({ task: 'work', starter: 'claude', startedBy: 'discord:owner', maxRounds: 10 }),
    ...overrides,
  };
  upsertCollabSession(MG, s);
  return s;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  routeInboundMock.mockClear();

  ({ collabInterceptor } = await import('./index.js'));

  createMessagingGroup({
    id: MG,
    channel_type: 'discord',
    platform_id: PLATFORM,
    name: 'Collab Chan',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now(),
  });
});

describe('collab/responder DB roundtrip', () => {
  it('persists and reads back an active session', () => {
    const s = seedSession({ nextAgent: 'codex', round: 3 });
    const read = getActiveCollabSession(MG);
    expect(read?.id).toBe(s.id);
    expect(read?.nextAgent).toBe('codex');
    expect(read?.round).toBe(3);
  });

  it('getActiveCollabSession hides non-active sessions', () => {
    seedSession({ status: 'complete' });
    expect(getActiveCollabSession(MG)).toBeUndefined();
    expect(getCollabSession(MG)?.status).toBe('complete');
  });

  it('responder defaults to claude and round-trips', () => {
    expect(getResponder(MG)).toBe('claude');
    setResponder(MG, 'codex', 'discord:owner');
    expect(getResponder(MG)).toBe('codex');
  });
});

describe('collabInterceptor', () => {
  it('ignores non-discord channels', async () => {
    const ev = discordEvent('hi');
    expect(await collabInterceptor({ ...ev, channelType: 'telegram' })).toBe(false);
  });

  it('ignores its own injected prompts', async () => {
    expect(await collabInterceptor(discordEvent('x', { id: 'collab-inject-123' }))).toBe(false);
  });

  it('passes through unknown channels', async () => {
    const ev = discordEvent('hi');
    expect(await collabInterceptor({ ...ev, platformId: 'discord:other' })).toBe(false);
  });

  it('responder=codex consumes when no active collab', async () => {
    setResponder(MG, 'codex', 'discord:owner');
    expect(await collabInterceptor(discordEvent('hello'))).toBe(true);
    expect(routeInboundMock).not.toHaveBeenCalled();
  });

  it('responder=claude (default) passes through', async () => {
    expect(await collabInterceptor(discordEvent('hello'))).toBe(false);
  });

  it('records a codex CONTINUE turn and dispatches Claude (flip-on-dispatch)', async () => {
    seedSession({ nextAgent: 'codex', round: 0 });
    const consumed = await collabInterceptor(discordEvent('did work\nCOLLAB_STATUS: CONTINUE'));
    expect(consumed).toBe(true);

    // Claude's turn was injected exactly once.
    expect(routeInboundMock).toHaveBeenCalledTimes(1);
    const injected = routeInboundMock.mock.calls[0][0];
    expect(injected.message.id.startsWith('collab-inject-')).toBe(true);

    // Codex turn (round 1) + Claude dispatch (round 2), next back to codex.
    const after = getActiveCollabSession(MG);
    expect(after?.round).toBe(2);
    expect(after?.nextAgent).toBe('codex');
    expect(after?.status).toBe('active');
  });

  it('completes on both-DONE without dispatching Claude', async () => {
    // Claude already done; codex now DONE → both-done.
    seedSession({ nextAgent: 'codex', done: { claude: true, codex: false } });
    const consumed = await collabInterceptor(discordEvent('finished\nCOLLAB_STATUS: DONE'));
    expect(consumed).toBe(true);
    expect(routeInboundMock).not.toHaveBeenCalled();
    expect(getActiveCollabSession(MG)).toBeUndefined();
    expect(getCollabSession(MG)?.status).toBe('complete');
  });

  it('consumes stray chatter during codex turn without recording', async () => {
    seedSession({ nextAgent: 'codex', round: 5 });
    const consumed = await collabInterceptor(discordEvent('just chatting, no protocol'));
    expect(consumed).toBe(true);
    expect(routeInboundMock).not.toHaveBeenCalled();
    expect(getActiveCollabSession(MG)?.round).toBe(5); // unchanged
  });

  it('suppresses raw inbound while it is Claude turn', async () => {
    seedSession({ nextAgent: 'claude', round: 1 });
    const consumed = await collabInterceptor(discordEvent('user noise'));
    expect(consumed).toBe(true);
    expect(routeInboundMock).not.toHaveBeenCalled();
  });
});

// keep closeDb referenced for symmetry with other suites
void closeDb;
