import fs from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import type { OutboundObservation } from '../../delivery.js';

const routeInboundMock = vi.fn(async (_event: InboundEvent) => {});
vi.mock('../../router.js', () => ({
  registerMessageInterceptor: vi.fn(),
  routeInbound: routeInboundMock,
}));

const registeredObservers: Array<(msg: OutboundObservation) => void> = [];
vi.mock('../../delivery.js', () => ({
  registerOutboundObserver: vi.fn((fn: (msg: OutboundObservation) => void) => {
    registeredObservers.push(fn);
  }),
  getDeliveryAdapter: vi.fn(() => null),
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

let collabInterceptor: (event: InboundEvent) => Promise<boolean>;
let observeClaudeTurn: (msg: OutboundObservation) => void;

function now() {
  return new Date().toISOString();
}

/** Inbound Discord event. `isBot` nests under `author` to match the Chat SDK
 *  serialization (toJSON) the real bridge produces. */
function discordEvent(
  text: string,
  opts: { id?: string; senderId?: string; isBot?: boolean } = {},
): InboundEvent {
  // The real Chat SDK toJSON always emits an `author` object (isBot nested),
  // so the fixture does too — a missing isBot defaults to false (a human).
  const content: Record<string, unknown> = {
    text,
    senderId: opts.senderId ?? 'discord:peer',
    author: { isBot: opts.isBot ?? false },
  };
  return {
    channelType: 'discord',
    platformId: PLATFORM,
    threadId: null,
    message: {
      id: opts.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat-sdk',
      content: JSON.stringify(content),
      timestamp: now(),
    },
  };
}

/** Outbound observation as the delivery layer fires it. The agent runner writes
 *  `{ text: body }`; `markdown` covers the alternate body field. */
function outboundMsg(
  text: string,
  opts: { useMarkdown?: boolean; channelType?: string; platformId?: string } = {},
): OutboundObservation {
  const content: Record<string, unknown> = opts.useMarkdown ? { markdown: text } : { text };
  return {
    channelType: opts.channelType ?? 'discord',
    platformId: opts.platformId ?? PLATFORM,
    threadId: null,
    kind: 'chat',
    content: JSON.stringify(content),
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
  // NB: do not reset registeredObservers — the module self-registers once at
  // first import (ESM cache), so clearing it here would wipe the registration
  // that a re-import won't repeat.

  ({ collabInterceptor, observeClaudeTurn } = await import('./index.js'));

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

  it('records a peer-bot CONTINUE turn and injects Claude (no pre-record)', async () => {
    seedSession({ nextAgent: 'codex', round: 0 });
    const consumed = await collabInterceptor(
      discordEvent('did work\nCOLLAB_STATUS: CONTINUE', { isBot: true }),
    );
    expect(consumed).toBe(true);

    // Claude's turn prompt was injected exactly once.
    expect(routeInboundMock).toHaveBeenCalledTimes(1);
    const injected = routeInboundMock.mock.calls[0][0];
    expect(injected.message.id.startsWith('collab-inject-')).toBe(true);

    // Only the codex turn is recorded here (round 0→1, flip to claude). Claude's
    // turn is NOT pre-recorded — it lands later via observeClaudeTurn.
    const after = getActiveCollabSession(MG);
    expect(after?.round).toBe(1);
    expect(after?.nextAgent).toBe('claude');
    expect(after?.status).toBe('active');
  });

  it('completes on both-DONE without injecting Claude', async () => {
    // Claude already done; codex now DONE → both-done.
    seedSession({ nextAgent: 'codex', done: { claude: true, codex: false } });
    const consumed = await collabInterceptor(
      discordEvent('finished\nCOLLAB_STATUS: DONE', { isBot: true }),
    );
    expect(consumed).toBe(true);
    expect(routeInboundMock).not.toHaveBeenCalled();
    expect(getActiveCollabSession(MG)).toBeUndefined();
    expect(getCollabSession(MG)?.status).toBe('complete');
  });

  it('ignores a human protocol line during codex turn (is-bot guard)', async () => {
    seedSession({ nextAgent: 'codex', round: 5 });
    // A human (no author.isBot) typing a status line must not count as a turn.
    const consumed = await collabInterceptor(
      discordEvent('COLLAB_STATUS: DONE', { isBot: false }),
    );
    expect(consumed).toBe(true);
    expect(routeInboundMock).not.toHaveBeenCalled();
    expect(getActiveCollabSession(MG)?.round).toBe(5); // unchanged
  });

  it('consumes stray bot chatter during codex turn without recording', async () => {
    seedSession({ nextAgent: 'codex', round: 5 });
    const consumed = await collabInterceptor(
      discordEvent('just chatting, no protocol', { isBot: true }),
    );
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

describe('observeClaudeTurn (outbound observer)', () => {
  it('registers itself via registerOutboundObserver', () => {
    expect(registeredObservers).toContain(observeClaudeTurn);
  });

  it('records a Claude CONTINUE from delivered output (round++/flip to codex)', () => {
    seedSession({ nextAgent: 'claude', round: 0 });
    observeClaudeTurn(outboundMsg('worked on it\nCOLLAB_STATUS: CONTINUE'));
    const after = getActiveCollabSession(MG);
    expect(after?.round).toBe(1);
    expect(after?.nextAgent).toBe('codex');
    expect(after?.status).toBe('active');
  });

  it('Claude DONE ends the session when codex already done (the Phase B fix)', () => {
    seedSession({ nextAgent: 'claude', done: { claude: false, codex: true } });
    observeClaudeTurn(outboundMsg('all finished\nCOLLAB_STATUS: DONE'));
    expect(getActiveCollabSession(MG)).toBeUndefined();
    expect(getCollabSession(MG)?.status).toBe('complete');
  });

  it('Claude BLOCKED halts the session on Claude', () => {
    seedSession({ nextAgent: 'claude', round: 2 });
    observeClaudeTurn(outboundMsg('need creds\nCOLLAB_STATUS: BLOCKED'));
    const s = getCollabSession(MG);
    expect(s?.status).toBe('blocked');
    expect(s?.nextAgent).toBe('claude');
  });

  it('does not record output without an explicit status line (multi-row safety)', () => {
    seedSession({ nextAgent: 'claude', round: 3 });
    observeClaudeTurn(outboundMsg('an intermediate chunk with no protocol line'));
    const after = getActiveCollabSession(MG);
    expect(after?.round).toBe(3); // unchanged
    expect(after?.nextAgent).toBe('claude');
  });

  it('reads a markdown body as well as text', () => {
    seedSession({ nextAgent: 'claude', round: 0 });
    observeClaudeTurn(outboundMsg('done a slice\nCOLLAB_STATUS: CONTINUE', { useMarkdown: true }));
    expect(getActiveCollabSession(MG)?.round).toBe(1);
  });

  it('ignores output when it is not Claude turn', () => {
    seedSession({ nextAgent: 'codex', round: 2 });
    observeClaudeTurn(outboundMsg('x\nCOLLAB_STATUS: DONE'));
    expect(getActiveCollabSession(MG)?.round).toBe(2); // unchanged
  });

  it('ignores non-discord and unknown groups', () => {
    seedSession({ nextAgent: 'claude', round: 0 });
    observeClaudeTurn(outboundMsg('x\nCOLLAB_STATUS: CONTINUE', { channelType: 'telegram' }));
    observeClaudeTurn(outboundMsg('x\nCOLLAB_STATUS: CONTINUE', { platformId: 'discord:other' }));
    expect(getActiveCollabSession(MG)?.round).toBe(0); // unchanged
  });
});

describe('full alternation (inbound codex ↔ outbound claude)', () => {
  it('drives a CONTINUE round trip: codex turn → Claude inject → Claude turn', async () => {
    seedSession({ nextAgent: 'codex', round: 0 });

    // 1. Peer bot (codex) hands off with CONTINUE → records codex turn, injects Claude.
    await collabInterceptor(discordEvent('codex slice\nCOLLAB_STATUS: CONTINUE', { isBot: true }));
    expect(getActiveCollabSession(MG)?.nextAgent).toBe('claude');
    expect(getActiveCollabSession(MG)?.round).toBe(1);
    expect(routeInboundMock).toHaveBeenCalledTimes(1);

    // 2. Claude's reply is delivered → records Claude turn, flips back to codex.
    observeClaudeTurn(outboundMsg('claude slice\nCOLLAB_STATUS: CONTINUE'));
    const after = getActiveCollabSession(MG);
    expect(after?.nextAgent).toBe('codex');
    expect(after?.round).toBe(2);
    expect(after?.status).toBe('active');
  });
});

// keep closeDb referenced for symmetry with other suites
void closeDb;
