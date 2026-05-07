import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  getResponder,
  isClaudeResponder,
  parseResponderCommand,
  setResponder,
} from './responder-state.js';

function tmpStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-responder-'));
  return path.join(dir, 'responder-state.json');
}

describe('responder state', () => {
  it('defaults to claude when no state file exists', () => {
    expect(getResponder('dc:channel', tmpStatePath())).toBe('claude');
  });

  it('persists a channel responder', () => {
    const statePath = tmpStatePath();

    setResponder('dc:channel', 'codex', 'user-1', statePath);

    expect(getResponder('dc:channel', statePath)).toBe('codex');
  });

  it('falls back to claude for invalid stored values', () => {
    const statePath = tmpStatePath();
    fs.writeFileSync(
      statePath,
      JSON.stringify({ channels: { 'dc:channel': { responder: 'gpt' } } }),
    );

    expect(getResponder('dc:channel', statePath)).toBe('claude');
  });

  it('routes claude and both to Claude, but not codex', () => {
    expect(isClaudeResponder('claude')).toBe(true);
    expect(isClaudeResponder('both')).toBe(true);
    expect(isClaudeResponder('codex')).toBe(false);
  });

  it('parses responder commands', () => {
    expect(parseResponderCommand('/responder')).toEqual({ type: 'status' });
    expect(parseResponderCommand('/responder codex')).toEqual({
      type: 'set',
      responder: 'codex',
    });
    expect(parseResponderCommand('/responder gpt')).toEqual({
      type: 'invalid',
    });
    expect(parseResponderCommand('/not-responder')).toBeNull();
  });
});
