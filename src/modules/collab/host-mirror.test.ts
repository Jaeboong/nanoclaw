import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';

import { chatJidForGroup, mirrorCollab, mirrorResponder } from './host-mirror.js';
import { createCollabSession } from './state.js';

const TEST_DIR = '/tmp/nanoclaw-test-host-mirror';
const RESPONDER_PATH = path.join(TEST_DIR, 'responder-state.json');
const COLLAB_PATH = path.join(TEST_DIR, 'collab-state.json');

// v2 stores discord groups as `discord:<guildId>:<channelId>`; v1 host files
// key on `dc:<channelId>`. 222 is the channel snowflake → chatJid `dc:222`.
const DISCORD_MG = 'mg-discord';
const DISCORD_PLATFORM = 'discord:111:222';
const DISCORD_JID = 'dc:222';
const WA_MG = 'mg-wa';

function now() {
  return new Date().toISOString();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  process.env.NANOCLAW_RESPONDER_STATE_PATH = RESPONDER_PATH;
  process.env.NANOCLAW_COLLAB_STATE_PATH = COLLAB_PATH;

  const db = initTestDb();
  runMigrations(db);
  createMessagingGroup({
    id: DISCORD_MG,
    channel_type: 'discord',
    platform_id: DISCORD_PLATFORM,
    name: 'Discord Chan',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: WA_MG,
    channel_type: 'whatsapp',
    platform_id: 'wa:abc',
    name: 'WA Chan',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now(),
  });
});

afterEach(() => {
  delete process.env.NANOCLAW_RESPONDER_STATE_PATH;
  delete process.env.NANOCLAW_COLLAB_STATE_PATH;
  closeDb();
});

function readJson(p: string): { channels: Record<string, Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('chatJidForGroup', () => {
  it('maps a discord group to dc:<trailing channel id>', () => {
    expect(chatJidForGroup(DISCORD_MG)).toBe(DISCORD_JID);
  });

  it('returns null for a non-discord group', () => {
    expect(chatJidForGroup(WA_MG)).toBeNull();
  });

  it('returns null for an unknown group id', () => {
    expect(chatJidForGroup('nope')).toBeNull();
  });
});

describe('mirrorResponder', () => {
  it('writes the v1 responder file keyed by chatJid', () => {
    mirrorResponder(DISCORD_MG, 'codex', 'user-1', '2026-07-01T00:00:00.000Z');
    const file = readJson(RESPONDER_PATH);
    expect(file.channels[DISCORD_JID]).toEqual({
      responder: 'codex',
      updatedBy: 'user-1',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
  });

  it('upserts without clobbering other channels owned by another bot', () => {
    fs.writeFileSync(RESPONDER_PATH, JSON.stringify({ channels: { 'dc:999': { responder: 'claude' } } }, null, 2));
    mirrorResponder(DISCORD_MG, 'both', 'user-1', now());
    const file = readJson(RESPONDER_PATH);
    expect(file.channels['dc:999']).toEqual({ responder: 'claude' });
    expect(file.channels[DISCORD_JID].responder).toBe('both');
  });

  it('no-ops for a non-discord group (file not created)', () => {
    mirrorResponder(WA_MG, 'codex', 'user-1', now());
    expect(fs.existsSync(RESPONDER_PATH)).toBe(false);
  });

  it('does not throw or clobber when the existing file is malformed', () => {
    fs.writeFileSync(RESPONDER_PATH, '{ not json');
    expect(() => mirrorResponder(DISCORD_MG, 'codex', 'user-1', now())).not.toThrow();
    // The unparseable file is left untouched rather than overwritten.
    expect(fs.readFileSync(RESPONDER_PATH, 'utf8')).toBe('{ not json');
  });
});

describe('mirrorCollab', () => {
  it('writes the full v1 session shape keyed by chatJid', () => {
    const session = {
      ...createCollabSession({ task: 'ship it', starter: 'claude', startedBy: 'owner', maxRounds: 8 }),
      nextAgent: 'codex' as const,
      round: 2,
      done: { claude: true, codex: false },
    };
    mirrorCollab(DISCORD_MG, session);
    const file = readJson(COLLAB_PATH);
    const written = file.channels[DISCORD_JID].session as typeof session;
    expect(written.nextAgent).toBe('codex');
    expect(written.round).toBe(2);
    expect(written.done).toEqual({ claude: true, codex: false });
    expect(written.task).toBe('ship it');
    expect(written.status).toBe('active');
  });

  it('preserves an existing defaultMaxRounds for the channel', () => {
    fs.writeFileSync(COLLAB_PATH, JSON.stringify({ channels: { [DISCORD_JID]: { defaultMaxRounds: 5 } } }, null, 2));
    const session = createCollabSession({ task: 't', starter: 'claude', startedBy: 'owner', maxRounds: 8 });
    mirrorCollab(DISCORD_MG, session);
    const file = readJson(COLLAB_PATH);
    expect(file.channels[DISCORD_JID].defaultMaxRounds).toBe(5);
    expect((file.channels[DISCORD_JID].session as { task: string }).task).toBe('t');
  });

  it('no-ops for a non-discord group', () => {
    const session = createCollabSession({ task: 't', starter: 'claude', startedBy: 'o', maxRounds: 8 });
    mirrorCollab(WA_MG, session);
    expect(fs.existsSync(COLLAB_PATH)).toBe(false);
  });
});
