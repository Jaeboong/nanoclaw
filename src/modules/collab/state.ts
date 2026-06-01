/**
 * Collab session state machine — pure logic, no I/O.
 *
 * A "collab" is a bounded, alternating Claude↔Codex collaboration in one
 * channel. 재붕봇 (Claude, this install) and 나붕봇 (Codex, a separate Discord
 * bot) hand off turns by posting messages that end with a `COLLAB_STATUS:`
 * protocol line. The host tracks whose turn it is, counts rounds, and ends the
 * session on both-DONE, BLOCKED, or max-rounds.
 *
 * Ported from the v1 fork's `collab-state.ts`. The transition functions here
 * are pure (session in → session out); persistence lives in `./db.ts`, keyed
 * by `messaging_group_id` (v2's channel identity) rather than v1's `chatJid`.
 */
import { randomUUID } from 'crypto';

export type CollabAgent = 'claude' | 'codex';
export type CollabTurnStatus = 'DONE' | 'CONTINUE' | 'NEEDS_USER' | 'BLOCKED';
export type CollabSessionStatus = 'active' | 'complete' | 'paused' | 'blocked' | 'stopped';

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

export type CollabTextCommand =
  | { readonly type: 'start'; readonly starter: CollabAgent; readonly task: string }
  | { readonly type: 'stop' }
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

export const DEFAULT_MAX_ROUNDS = 10;
const UNLIMITED_MAX_ROUNDS = 0;
const MIN_BOUNDED_MAX_ROUNDS = 1;
const HARD_MAX_ROUNDS = 50;

function nowIso(): string {
  return new Date().toISOString();
}

function otherAgent(agent: CollabAgent): CollabAgent {
  return agent === 'claude' ? 'codex' : 'claude';
}

export function isCollabAgent(value: unknown): value is CollabAgent {
  return value === 'claude' || value === 'codex';
}

export function normalizeMaxRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  const floored = Math.floor(value);
  if (floored === UNLIMITED_MAX_ROUNDS) return UNLIMITED_MAX_ROUNDS;
  return Math.min(HARD_MAX_ROUNDS, Math.max(MIN_BOUNDED_MAX_ROUNDS, floored));
}

function parseCollabStatusToken(value: string | undefined): CollabTurnStatus | undefined {
  const normalized = value?.trim().toUpperCase();
  if (
    normalized === 'DONE' ||
    normalized === 'CONTINUE' ||
    normalized === 'NEEDS_USER' ||
    normalized === 'BLOCKED'
  ) {
    return normalized;
  }
  return undefined;
}

const EXPLICIT_STATUS_RE =
  /^\s*(?:COLLAB_STATUS|STATUS)\s*[:=-]\s*(DONE|CONTINUE|NEEDS_USER|BLOCKED)\b/im;

function lastNonEmptyLine(text: string): string | undefined {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

export function parseCollabTurnStatus(text: string): CollabTurnStatus {
  const explicit = text.match(EXPLICIT_STATUS_RE);
  const explicitStatus = parseCollabStatusToken(explicit?.[1]);
  if (explicitStatus) return explicitStatus;

  const lastLineStatus = parseCollabStatusToken(lastNonEmptyLine(text));
  if (lastLineStatus) return lastLineStatus;
  return 'CONTINUE';
}

export function hasExplicitCollabTurnStatus(text: string): boolean {
  if (EXPLICIT_STATUS_RE.test(text)) return true;
  return parseCollabStatusToken(lastNonEmptyLine(text)) !== undefined;
}

function formatMaxRoundsForPrompt(maxRounds: number): string {
  return maxRounds === UNLIMITED_MAX_ROUNDS ? 'unlimited' : String(maxRounds);
}

export function createCollabSession(params: {
  readonly task: string;
  readonly starter: CollabAgent;
  readonly startedBy: string;
  readonly maxRounds: number;
}): CollabSession {
  const timestamp = nowIso();
  return {
    id: randomUUID(),
    task: params.task.trim(),
    starter: params.starter,
    nextAgent: params.starter,
    maxRounds: normalizeMaxRounds(params.maxRounds),
    round: 0,
    done: { claude: false, codex: false },
    status: 'active',
    startedBy: params.startedBy,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

export function stopCollabSession(session: CollabSession): CollabSession {
  return { ...session, status: 'stopped', endedReason: 'stopped', updatedAt: nowIso() };
}

/**
 * Apply one agent turn to a session. Pure: returns the next session and the
 * routing reason. `NEEDS_USER` is downgraded to `CONTINUE` — the prompt asks
 * agents to keep going autonomously, so a stray NEEDS_USER shouldn't stall.
 */
export function applyAgentTurn(
  session: CollabSession,
  agent: CollabAgent,
  text: string,
): CollabTurnResult {
  if (session.status !== 'active') return { session: null, reason: 'not-active' };
  if (session.nextAgent !== agent) return { session, reason: 'wrong-agent' };

  const parsed = parseCollabTurnStatus(text);
  const turnStatus: CollabTurnStatus = parsed === 'NEEDS_USER' ? 'CONTINUE' : parsed;
  const round = session.round + 1;
  const done = {
    ...session.done,
    [agent]: turnStatus === 'DONE' ? true : session.done[agent],
  };

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
  } else if (session.maxRounds > UNLIMITED_MAX_ROUNDS && round >= session.maxRounds) {
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
    updatedAt: nowIso(),
    ...(endedReason ? { endedReason } : {}),
  };
  return { session: updated, reason };
}

export function buildCollabTurnPrompt(params: {
  readonly agent: CollabAgent;
  readonly task: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly conversation: string;
}): string {
  const agentLabel = params.agent === 'claude' ? '재붕봇(Claude)' : '나붕봇(Codex)';
  const maxRoundsLabel = formatMaxRoundsForPrompt(params.maxRounds);
  return [
    '[COLLAB SESSION]',
    `You are ${agentLabel}.`,
    `Task: ${params.task}`,
    `Current round ${params.round}/${maxRoundsLabel}. One round is one agent turn.`,
    ...(params.maxRounds === UNLIMITED_MAX_ROUNDS
      ? ['Max rounds is 0 (unlimited): continue until both agents declare DONE unless BLOCKED.']
      : []),
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

export function buildCodexStarterHandoffMessage(session: CollabSession): string {
  return `나붕봇, collab 첫 턴 시작.\n\n사용자 요청: ${session.task}`;
}

export function parseCollabTextCommand(text: string): CollabTextCommand | null {
  const trimmed = text.trim();
  const prefix = trimmed.startsWith('./collab')
    ? './collab'
    : trimmed.startsWith('/collab')
      ? '/collab'
      : null;
  if (!prefix) return null;
  const rest = trimmed.slice(prefix.length).trim();
  if (!rest) return { type: 'invalid', reason: 'Usage: ./collab <task>' };

  const [firstRaw, ...tailParts] = rest.split(/\s+/);
  const first = firstRaw?.toLowerCase();
  const tail = tailParts.join(' ').trim();

  if (first === 'stop' && !tail) return { type: 'stop' };

  if (first === '나붕봇' || first === 'codex') {
    return tail
      ? { type: 'start', starter: 'codex', task: tail }
      : { type: 'invalid', reason: 'Usage: ./collab 나붕봇 <task>' };
  }
  if (first === '재붕봇' || first === 'claude') {
    return tail
      ? { type: 'start', starter: 'claude', task: tail }
      : { type: 'invalid', reason: 'Usage: ./collab 재붕봇 <task>' };
  }

  return { type: 'start', starter: 'claude', task: rest };
}
