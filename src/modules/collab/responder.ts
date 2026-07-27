/**
 * Per-channel responder mode — pure logic, no I/O.
 *
 * In a channel shared by 재붕봇 (Claude, this install) and 나붕봇 (Codex, a
 * separate bot), the responder toggle picks who answers:
 *   'claude' — only this install answers (default)
 *   'codex'  — this install stays silent; the peer bot handles it
 *   'both'   — both answer
 *
 * Ported from the v1 fork's `responder-state.ts` / `responder-routing.ts`.
 * Persistence lives in `./db.ts`, keyed by `messaging_group_id`.
 */
import type { CollabAgent } from './state.js';

export type Responder = 'claude' | 'codex' | 'both';

export function isResponder(value: unknown): value is Responder {
  return value === 'claude' || value === 'codex' || value === 'both';
}

export function isClaudeResponder(responder: Responder): boolean {
  return responder === 'claude' || responder === 'both';
}

export type ResponderCommand =
  | { type: 'status' }
  | { type: 'set'; responder: Responder }
  | { type: 'invalid' };

export function parseResponderCommand(content: string): ResponderCommand | null {
  const parts = content.trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== '/responder') return null;
  if (parts.length === 1) return { type: 'status' };
  if (parts.length === 2 && isResponder(parts[1])) {
    return { type: 'set', responder: parts[1] };
  }
  return { type: 'invalid' };
}

/**
 * Should this install (Claude) handle the message, given the responder mode
 * and any active collab turn-taking?
 *
 * Collab takes precedence: during an active session, only the agent whose
 * turn it is engages. Otherwise the responder mode decides.
 */
export function claudeShouldHandle(params: {
  readonly responder: Responder;
  readonly collab?: { readonly active: boolean; readonly nextAgent: CollabAgent };
}): boolean {
  if (params.collab?.active) {
    return params.collab.nextAgent === 'claude';
  }
  return isClaudeResponder(params.responder);
}
