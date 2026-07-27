/**
 * Write-through mirror of collab + responder state to v1-format host JSON files.
 *
 * v2 keeps these in SQLite (see {@link ./db}), but the sibling Codex bot
 * (나붕봇) only reads v1's shared host files at
 * `~/.config/nanoclaw/{responder,collab}-state.json`, keyed by the v1 chatJid
 * `dc:<discordChannelId>`. So every DB write also upserts the single affected
 * channel entry here, keeping cross-bot coordination working.
 *
 * One-way (v2 → host files): NanoClaw is the sole writer of responder/turn
 * state; 나붕봇 only reads. Read-modify-write touches just the one channel so
 * entries this process doesn't own are preserved. Never throws into the DB
 * path — mirroring is best-effort: on a malformed/locked file it logs and
 * skips the write rather than clobber the other bots' channels, so the DB
 * write still succeeds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';

import type { Responder } from './responder.js';
import type { CollabSession } from './state.js';

function configDir(): string {
  return path.join(os.homedir(), '.config', 'nanoclaw');
}

/**
 * Resolve the host file paths each call so the systemd environment (and tests)
 * can override them. `collab-state.json` honors `NANOCLAW_COLLAB_STATE_PATH`
 * exactly as v1's config does; the responder override is a v2-only test seam
 * (unset in production, so the default path matches v1).
 */
function responderStatePath(): string {
  return process.env.NANOCLAW_RESPONDER_STATE_PATH || path.join(configDir(), 'responder-state.json');
}
function collabStatePath(): string {
  return process.env.NANOCLAW_COLLAB_STATE_PATH || path.join(configDir(), 'collab-state.json');
}

/**
 * v1 chatJid for a messaging group, or null when it isn't a Discord group.
 *
 * v2 stores Discord groups as `platform_id = discord:<guildId>:<channelId>`
 * (or `discord:@me:<channelId>`), whereas v1's host files key on
 * `dc:<channelId>` — so take the trailing channel snowflake, not the whole
 * platform id.
 */
export function chatJidForGroup(messagingGroupId: string): string | null {
  const mg = getMessagingGroup(messagingGroupId);
  if (!mg || mg.channel_type !== 'discord' || !mg.platform_id) return null;
  const channelId = mg.platform_id.split(':').pop();
  if (!channelId || !/^\d+$/.test(channelId)) return null;
  return `dc:${channelId}`;
}

interface ChannelsFile<T> {
  channels: Record<string, T>;
}

/**
 * Read the `{ channels: {...} }` map, returning an empty map for a missing
 * file. A file that exists but can't be read/parsed throws — the caller skips
 * the write so a transient parse failure never wipes other bots' channels.
 */
function readChannels<T>(filePath: string): ChannelsFile<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { channels: {} };
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<ChannelsFile<T>>;
  return { channels: parsed.channels ?? {} };
}

function writeChannels<T>(filePath: string, file: ChannelsFile<T>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic write: 나붕봇 polls this file most aggressively *during* a collab turn
  // (exactly when mirrorCollab fires), so a partial read of a half-written file
  // would corrupt its turn-taking. temp+rename makes the swap atomic on the same
  // filesystem — readers see either the old or the new file, never a torn one.
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

interface ResponderEntry {
  responder: Responder;
  updatedBy?: string;
  updatedAt?: string;
}

/** Mirror a responder change to the v1 host file (no-op for non-Discord). */
export function mirrorResponder(
  messagingGroupId: string,
  responder: Responder,
  updatedBy: string,
  updatedAt: string,
): void {
  const chatJid = chatJidForGroup(messagingGroupId);
  if (!chatJid) return;
  try {
    const file = readChannels<ResponderEntry>(responderStatePath());
    file.channels[chatJid] = { responder, updatedBy, updatedAt };
    writeChannels(responderStatePath(), file);
  } catch (err) {
    log.warn('collab host-mirror: responder write-through skipped', { err: String(err), chatJid });
  }
}

interface CollabEntry {
  defaultMaxRounds?: number;
  session?: CollabSession;
}

/**
 * Mirror a collab session to the v1 host file (no-op for non-Discord). The
 * v2 in-memory {@link CollabSession} already matches v1's `session` shape
 * (`done: { claude, codex }`, `nextAgent`, …), so it serializes directly. An
 * existing `defaultMaxRounds` for the channel is preserved.
 */
export function mirrorCollab(messagingGroupId: string, session: CollabSession): void {
  const chatJid = chatJidForGroup(messagingGroupId);
  if (!chatJid) return;
  try {
    const file = readChannels<CollabEntry>(collabStatePath());
    const existing = file.channels[chatJid] ?? {};
    file.channels[chatJid] = { ...existing, session };
    writeChannels(collabStatePath(), file);
  } catch (err) {
    log.warn('collab host-mirror: collab write-through skipped', { err: String(err), chatJid });
  }
}
