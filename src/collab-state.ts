import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { COLLAB_STATE_PATH } from './config.js';

export type CollabAgent = 'claude' | 'codex';
export type CollabTurnStatus = 'DONE' | 'CONTINUE' | 'NEEDS_USER' | 'BLOCKED';
export type CollabSessionStatus =
  | 'active'
  | 'complete'
  | 'paused'
  | 'blocked'
  | 'stopped';

export interface CollabSession {
  readonly id: string;
  readonly task: string;
  readonly starter: CollabAgent;
  readonly nextAgent: CollabAgent;
  readonly maxRounds: number;
  readonly round: number;
  readonly done: Record<CollabAgent, boolean>;
  readonly status: CollabSessionStatus;
  readonly startedBy: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastStatus?: CollabTurnStatus;
  readonly lastAgent?: CollabAgent;
  readonly endedReason?: string;
}

export interface CollabChannelState {
  readonly defaultMaxRounds?: number;
  readonly session?: CollabSession;
}

export interface CollabState {
  readonly channels: Record<string, CollabChannelState>;
}

export type CollabTextCommand =
  | {
      readonly type: 'start';
      readonly starter: CollabAgent;
      readonly task: string;
    }
  | { readonly type: 'invalid'; readonly reason: string };

export interface CollabTurnResult {
  readonly session: CollabSession | null;
  readonly reason:
    | 'not-active'
    | 'wrong-agent'
    | 'continue'
    | 'both-done'
    | 'max-rounds'
    | 'needs-user'
    | 'blocked';
}

const DEFAULT_MAX_ROUNDS = 10;
const MIN_MAX_ROUNDS = 1;
const HARD_MAX_ROUNDS = 50;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isAgent(value: unknown): value is CollabAgent {
  return value === 'claude' || value === 'codex';
}

function otherAgent(agent: CollabAgent): CollabAgent {
  return agent === 'claude' ? 'codex' : 'claude';
}

function normalizeMaxRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  return Math.min(HARD_MAX_ROUNDS, Math.max(MIN_MAX_ROUNDS, Math.floor(value)));
}

function statePath(filePath?: string): string {
  return filePath ?? COLLAB_STATE_PATH;
}

function emptyState(): CollabState {
  return { channels: {} };
}

function normalizeSession(value: unknown): CollabSession | undefined {
  if (!isRecord(value)) return undefined;
  if (!isAgent(value.starter) || !isAgent(value.nextAgent)) return undefined;
  if (typeof value.task !== 'string' || value.task.trim() === '') {
    return undefined;
  }
  const status =
    value.status === 'active' ||
    value.status === 'complete' ||
    value.status === 'paused' ||
    value.status === 'blocked' ||
    value.status === 'stopped'
      ? value.status
      : 'active';
  const doneValue = isRecord(value.done) ? value.done : {};
  return {
    id: typeof value.id === 'string' ? value.id : randomUUID(),
    task: value.task,
    starter: value.starter,
    nextAgent: value.nextAgent,
    maxRounds: normalizeMaxRounds(
      typeof value.maxRounds === 'number'
        ? value.maxRounds
        : DEFAULT_MAX_ROUNDS,
    ),
    round: Math.max(0, Math.floor(Number(value.round) || 0)),
    done: {
      claude: doneValue.claude === true,
      codex: doneValue.codex === true,
    },
    status,
    startedBy:
      typeof value.startedBy === 'string' ? value.startedBy : 'unknown',
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : nowIso(),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso(),
    ...(value.lastStatus === 'DONE' ||
    value.lastStatus === 'CONTINUE' ||
    value.lastStatus === 'NEEDS_USER' ||
    value.lastStatus === 'BLOCKED'
      ? { lastStatus: value.lastStatus }
      : {}),
    ...(isAgent(value.lastAgent) ? { lastAgent: value.lastAgent } : {}),
    ...(typeof value.endedReason === 'string'
      ? { endedReason: value.endedReason }
      : {}),
  };
}

function normalizeState(raw: unknown): CollabState {
  if (!isRecord(raw) || !isRecord(raw.channels)) return emptyState();
  const channels: Record<string, CollabChannelState> = {};
  for (const [chatJid, value] of Object.entries(raw.channels)) {
    if (!isRecord(value)) continue;
    const channelState: CollabChannelState = {
      ...(typeof value.defaultMaxRounds === 'number'
        ? { defaultMaxRounds: normalizeMaxRounds(value.defaultMaxRounds) }
        : {}),
      ...(normalizeSession(value.session)
        ? { session: normalizeSession(value.session) }
        : {}),
    };
    channels[chatJid] = channelState;
  }
  return { channels };
}

export function readCollabState(filePath?: string): CollabState {
  try {
    return normalizeState(
      JSON.parse(fs.readFileSync(statePath(filePath), 'utf8')),
    );
  } catch {
    return emptyState();
  }
}

export function writeCollabState(state: CollabState, filePath?: string): void {
  const target = statePath(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
}

function updateChannel(
  chatJid: string,
  updater: (channel: CollabChannelState) => CollabChannelState,
  filePath?: string,
): CollabChannelState {
  const state = readCollabState(filePath);
  const current = state.channels[chatJid] ?? {};
  const next = updater(current);
  writeCollabState(
    {
      channels: {
        ...state.channels,
        [chatJid]: next,
      },
    },
    filePath,
  );
  return next;
}

export function getCollabSession(
  chatJid: string,
  filePath?: string,
): CollabSession | undefined {
  return readCollabState(filePath).channels[chatJid]?.session;
}

export function getActiveCollabSession(
  chatJid: string,
  filePath?: string,
): CollabSession | undefined {
  const session = getCollabSession(chatJid, filePath);
  return session?.status === 'active' ? session : undefined;
}

export function getCollabMaxRounds(chatJid: string, filePath?: string): number {
  return (
    readCollabState(filePath).channels[chatJid]?.defaultMaxRounds ??
    DEFAULT_MAX_ROUNDS
  );
}

export function setCollabMaxRounds(
  chatJid: string,
  maxRounds: number,
  _updatedBy: string,
  filePath?: string,
): number {
  const normalized = normalizeMaxRounds(maxRounds);
  updateChannel(
    chatJid,
    (channel) => ({
      ...channel,
      defaultMaxRounds: normalized,
    }),
    filePath,
  );
  return normalized;
}

export function startCollabSession(
  params: {
    readonly chatJid: string;
    readonly task: string;
    readonly starter: CollabAgent;
    readonly startedBy: string;
    readonly maxRounds?: number;
  },
  filePath?: string,
): CollabSession {
  const task = params.task.trim();
  const timestamp = nowIso();
  const maxRounds =
    params.maxRounds === undefined
      ? getCollabMaxRounds(params.chatJid, filePath)
      : normalizeMaxRounds(params.maxRounds);
  const session: CollabSession = {
    id: randomUUID(),
    task,
    starter: params.starter,
    nextAgent: params.starter,
    maxRounds,
    round: 0,
    done: { claude: false, codex: false },
    status: 'active',
    startedBy: params.startedBy,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  updateChannel(
    params.chatJid,
    (channel) => ({
      ...channel,
      defaultMaxRounds: channel.defaultMaxRounds ?? DEFAULT_MAX_ROUNDS,
      session,
    }),
    filePath,
  );
  return session;
}

export function stopCollabSession(
  chatJid: string,
  _stoppedBy: string,
  filePath?: string,
): CollabSession | null {
  const current = getCollabSession(chatJid, filePath);
  if (!current) return null;
  const stopped: CollabSession = {
    ...current,
    status: 'stopped',
    endedReason: 'stopped',
    updatedAt: nowIso(),
  };
  updateChannel(
    chatJid,
    (channel) => ({ ...channel, session: stopped }),
    filePath,
  );
  return stopped;
}

export function parseCollabTurnStatus(text: string): CollabTurnStatus {
  const explicit = text.match(
    /^\s*(?:COLLAB_STATUS|STATUS)\s*[:=-]\s*(DONE|CONTINUE|NEEDS_USER|BLOCKED)\b/im,
  );
  if (explicit) return explicit[1] as CollabTurnStatus;

  const lastLine = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (
    lastLine === 'DONE' ||
    lastLine === 'CONTINUE' ||
    lastLine === 'NEEDS_USER' ||
    lastLine === 'BLOCKED'
  ) {
    return lastLine;
  }
  return 'CONTINUE';
}

export function hasExplicitCollabTurnStatus(text: string): boolean {
  if (
    /^\s*(?:COLLAB_STATUS|STATUS)\s*[:=-]\s*(DONE|CONTINUE|NEEDS_USER|BLOCKED)\b/im.test(
      text,
    )
  ) {
    return true;
  }
  const lastLine = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return (
    lastLine === 'DONE' ||
    lastLine === 'CONTINUE' ||
    lastLine === 'NEEDS_USER' ||
    lastLine === 'BLOCKED'
  );
}

export function recordCollabAgentTurn(
  chatJid: string,
  agent: CollabAgent,
  text: string,
  filePath?: string,
): CollabTurnResult {
  const session = getActiveCollabSession(chatJid, filePath);
  if (!session) return { session: null, reason: 'not-active' };
  if (session.nextAgent !== agent) {
    return { session, reason: 'wrong-agent' };
  }

  const parsedTurnStatus = parseCollabTurnStatus(text);
  const turnStatus: CollabTurnStatus =
    parsedTurnStatus === 'NEEDS_USER' ? 'CONTINUE' : parsedTurnStatus;
  const round = session.round + 1;
  const done = {
    ...session.done,
    [agent]: turnStatus === 'DONE' ? true : session.done[agent],
  };
  const timestamp = nowIso();
  let status: CollabSessionStatus = 'active';
  let nextAgent = otherAgent(agent);
  let endedReason: string | undefined;
  let reason: CollabTurnResult['reason'] = 'continue';

  if (turnStatus === 'BLOCKED') {
    status = 'blocked';
    endedReason = 'blocked';
    nextAgent = agent;
    reason = 'blocked';
  } else if (done.claude && done.codex) {
    status = 'complete';
    endedReason = 'both-done';
    reason = 'both-done';
  } else if (round >= session.maxRounds) {
    status = 'complete';
    endedReason = 'max-rounds';
    reason = 'max-rounds';
  }

  const updated: CollabSession = {
    ...session,
    round,
    done,
    nextAgent,
    status,
    lastStatus: turnStatus,
    lastAgent: agent,
    updatedAt: timestamp,
    ...(endedReason ? { endedReason } : {}),
  };

  updateChannel(
    chatJid,
    (channel) => ({ ...channel, session: updated }),
    filePath,
  );
  return { session: updated, reason };
}

export function isCollabTurnForAgent(
  chatJid: string,
  agent: CollabAgent,
  filePath?: string,
): boolean {
  return getActiveCollabSession(chatJid, filePath)?.nextAgent === agent;
}

export function shouldIncludeBotMessagesForCollabRecovery(
  chatJid: string,
  filePath?: string,
): boolean {
  return getActiveCollabSession(chatJid, filePath)?.nextAgent === 'claude';
}

export function buildCollabTurnPrompt(params: {
  readonly agent: CollabAgent;
  readonly task: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly conversation: string;
}): string {
  const agentLabel =
    params.agent === 'claude' ? '재붕봇(Claude)' : '나붕봇(Codex)';
  return [
    '[COLLAB SESSION]',
    `You are ${agentLabel}.`,
    `Task: ${params.task}`,
    `Current round ${params.round}/${params.maxRounds}. One round is one agent turn.`,
    'Read the prior conversation, do only the next useful slice of work, and hand off if more work remains.',
    'Do not use NEEDS_USER. For routine writes, cleanup, verification, and Notion updates, continue autonomously.',
    'Use BLOCKED only when missing credentials/permissions or a genuinely high-risk/destructive choice requires the user.',
    'End your reply with exactly one protocol line:',
    'COLLAB_STATUS: DONE|CONTINUE|BLOCKED',
    '',
    params.conversation,
  ].join('\n');
}

export function buildCollabKickoffMessage(session: CollabSession): string {
  const starter = session.starter === 'claude' ? '재붕봇' : '나붕봇';
  return buildCollabTurnPrompt({
    agent: session.starter,
    task: session.task,
    round: 1,
    maxRounds: session.maxRounds,
    conversation: `사용자 요청: ${session.task}\n\n${starter}부터 시작한다.`,
  });
}

export function parseCollabTextCommand(text: string): CollabTextCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/collab')) return null;
  const rest = trimmed.slice('/collab'.length).trim();
  if (!rest) return { type: 'invalid', reason: 'Usage: /collab <task>' };

  const [firstRaw, ...tailParts] = rest.split(/\s+/);
  const first = firstRaw?.toLowerCase();
  const tail = tailParts.join(' ').trim();

  if (first === '나붕봇' || first === 'codex') {
    return tail
      ? { type: 'start', starter: 'codex', task: tail }
      : { type: 'invalid', reason: 'Usage: /collab 나붕봇 <task>' };
  }
  if (first === '재붕봇' || first === 'claude') {
    return tail
      ? { type: 'start', starter: 'claude', task: tail }
      : { type: 'invalid', reason: 'Usage: /collab 재붕봇 <task>' };
  }

  return { type: 'start', starter: 'claude', task: rest };
}
