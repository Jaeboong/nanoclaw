import { describe, expect, it } from 'vitest';

import {
  claudeShouldHandle,
  isClaudeResponder,
  isResponder,
  parseResponderCommand,
} from './responder.js';

describe('responder predicates', () => {
  it('isResponder narrows valid modes', () => {
    expect(isResponder('claude')).toBe(true);
    expect(isResponder('codex')).toBe(true);
    expect(isResponder('both')).toBe(true);
    expect(isResponder('nope')).toBe(false);
  });
  it('isClaudeResponder is true for claude/both', () => {
    expect(isClaudeResponder('claude')).toBe(true);
    expect(isClaudeResponder('both')).toBe(true);
    expect(isClaudeResponder('codex')).toBe(false);
  });
});

describe('parseResponderCommand', () => {
  it('returns null for non-responder text', () => {
    expect(parseResponderCommand('/collab x')).toBeNull();
  });
  it('status with no arg', () => {
    expect(parseResponderCommand('/responder')).toEqual({ type: 'status' });
  });
  it('set with a valid mode', () => {
    expect(parseResponderCommand('/responder both')).toEqual({ type: 'set', responder: 'both' });
  });
  it('invalid for bad mode', () => {
    expect(parseResponderCommand('/responder nonsense')).toEqual({ type: 'invalid' });
  });
});

describe('claudeShouldHandle', () => {
  it('responder mode governs when no active collab', () => {
    expect(claudeShouldHandle({ responder: 'claude' })).toBe(true);
    expect(claudeShouldHandle({ responder: 'both' })).toBe(true);
    expect(claudeShouldHandle({ responder: 'codex' })).toBe(false);
  });
  it('active collab overrides responder mode', () => {
    expect(
      claudeShouldHandle({ responder: 'codex', collab: { active: true, nextAgent: 'claude' } }),
    ).toBe(true);
    expect(
      claudeShouldHandle({ responder: 'both', collab: { active: true, nextAgent: 'codex' } }),
    ).toBe(false);
  });
});
