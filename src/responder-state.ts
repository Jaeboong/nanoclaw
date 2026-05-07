import fs from 'fs';
import path from 'path';

import { RESPONDER_STATE_PATH } from './config.js';
import { logger } from './logger.js';

export type Responder = 'claude' | 'codex' | 'both';

interface ChannelResponderEntry {
  readonly responder: Responder;
  readonly updatedBy?: string;
  readonly updatedAt?: string;
}

interface ResponderStateFile {
  readonly channels: Record<string, ChannelResponderEntry>;
}

export type ResponderCommand =
  | { type: 'status' }
  | { type: 'set'; responder: Responder }
  | { type: 'invalid' };

const VALID_RESPONDERS: readonly Responder[] = ['claude', 'codex', 'both'];

function isResponder(value: unknown): value is Responder {
  return value === 'claude' || value === 'codex' || value === 'both';
}

function emptyState(): ResponderStateFile {
  return { channels: {} };
}

function hasErrorCode(value: unknown, code: string): boolean {
  return value instanceof Error && 'code' in value && value.code === code;
}

function readStringProperty(
  value: Record<string, unknown>,
  property: string,
): string | undefined {
  const candidate = value[property];
  return typeof candidate === 'string' ? candidate : undefined;
}

function normalizeState(value: unknown): ResponderStateFile {
  if (typeof value !== 'object' || value === null || !('channels' in value)) {
    return emptyState();
  }

  const channelsValue = value.channels;
  if (
    typeof channelsValue !== 'object' ||
    channelsValue === null ||
    Array.isArray(channelsValue)
  ) {
    return emptyState();
  }

  const channels: Record<string, ChannelResponderEntry> = {};
  for (const [chatJid, entryValue] of Object.entries(channelsValue)) {
    if (
      typeof entryValue !== 'object' ||
      entryValue === null ||
      !('responder' in entryValue) ||
      !isResponder(entryValue.responder)
    ) {
      continue;
    }

    channels[chatJid] = {
      responder: entryValue.responder,
      updatedBy: readStringProperty(entryValue, 'updatedBy'),
      updatedAt: readStringProperty(entryValue, 'updatedAt'),
    };
  }

  return { channels };
}

function loadState(filePath: string): ResponderStateFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if (hasErrorCode(err, 'ENOENT')) return emptyState();
    logger.warn({ err, path: filePath }, 'responder-state: cannot read file');
    return emptyState();
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    logger.warn({ path: filePath }, 'responder-state: invalid JSON');
    return emptyState();
  }
}

function saveState(filePath: string, state: ResponderStateFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function getResponder(
  chatJid: string,
  filePath = RESPONDER_STATE_PATH,
): Responder {
  const entry = loadState(filePath).channels[chatJid];
  return isResponder(entry?.responder) ? entry.responder : 'claude';
}

export function setResponder(
  chatJid: string,
  responder: Responder,
  updatedBy: string,
  filePath = RESPONDER_STATE_PATH,
): void {
  const state = loadState(filePath);
  state.channels[chatJid] = {
    responder,
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  saveState(filePath, state);
}

export function isClaudeResponder(responder: Responder): boolean {
  return responder === 'claude' || responder === 'both';
}

export function parseResponderCommand(
  content: string,
): ResponderCommand | null {
  const parts = content.trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== '/responder') return null;
  if (parts.length === 1) return { type: 'status' };
  if (parts.length === 2 && isResponder(parts[1])) {
    return { type: 'set', responder: parts[1] };
  }
  return { type: 'invalid' };
}
