import { describe, expect, it } from 'vitest';

import {
  applyAgentTurn,
  buildCollabKickoffMessage,
  buildCollabTurnPrompt,
  createCollabSession,
  hasExplicitCollabTurnStatus,
  isCollabAgent,
  normalizeMaxRounds,
  parseCollabTextCommand,
  parseCollabTurnStatus,
  stopCollabSession,
  type CollabSession,
} from './state.js';

function session(overrides: Partial<CollabSession> = {}): CollabSession {
  return {
    ...createCollabSession({ task: 'do a thing', starter: 'claude', startedBy: 'discord:1', maxRounds: 10 }),
    ...overrides,
  };
}

describe('parseCollabTurnStatus', () => {
  it('reads an explicit COLLAB_STATUS line anywhere', () => {
    expect(parseCollabTurnStatus('work\nCOLLAB_STATUS: DONE')).toBe('DONE');
    expect(parseCollabTurnStatus('STATUS = blocked')).toBe('BLOCKED');
  });
  it('falls back to a bare last line', () => {
    expect(parseCollabTurnStatus('did stuff\nCONTINUE')).toBe('CONTINUE');
  });
  it('defaults to CONTINUE when absent', () => {
    expect(parseCollabTurnStatus('just some prose')).toBe('CONTINUE');
  });
});

describe('hasExplicitCollabTurnStatus', () => {
  it('detects explicit and bare-last-line forms', () => {
    expect(hasExplicitCollabTurnStatus('x\nCOLLAB_STATUS: DONE')).toBe(true);
    expect(hasExplicitCollabTurnStatus('done\nDONE')).toBe(true);
  });
  it('is false for prose', () => {
    expect(hasExplicitCollabTurnStatus('no protocol here')).toBe(false);
  });
});

describe('normalizeMaxRounds', () => {
  it('keeps 0 as unlimited and clamps bounds', () => {
    expect(normalizeMaxRounds(0)).toBe(0);
    expect(normalizeMaxRounds(-5)).toBe(1);
    expect(normalizeMaxRounds(999)).toBe(50);
    expect(normalizeMaxRounds(Number.NaN)).toBe(10);
  });
});

describe('applyAgentTurn', () => {
  it('rejects when not the agent turn', () => {
    const s = session({ nextAgent: 'codex' });
    expect(applyAgentTurn(s, 'claude', 'CONTINUE').reason).toBe('wrong-agent');
  });

  it('rejects when session inactive', () => {
    const s = session({ status: 'complete' });
    expect(applyAgentTurn(s, 'claude', 'CONTINUE').reason).toBe('not-active');
  });

  it('CONTINUE advances round and flips agent', () => {
    const s = session({ nextAgent: 'claude', round: 0 });
    const r = applyAgentTurn(s, 'claude', 'COLLAB_STATUS: CONTINUE');
    expect(r.session?.round).toBe(1);
    expect(r.session?.nextAgent).toBe('codex');
    expect(r.session?.status).toBe('active');
  });

  it('both DONE completes the session', () => {
    let s = session({ nextAgent: 'claude' });
    s = applyAgentTurn(s, 'claude', 'COLLAB_STATUS: DONE').session as CollabSession;
    expect(s.status).toBe('active'); // only one side done
    const r = applyAgentTurn(s, 'codex', 'COLLAB_STATUS: DONE');
    expect(r.session?.status).toBe('complete');
    expect(r.reason).toBe('both-done');
  });

  it('BLOCKED halts and keeps the same agent', () => {
    const s = session({ nextAgent: 'codex' });
    const r = applyAgentTurn(s, 'codex', 'COLLAB_STATUS: BLOCKED');
    expect(r.session?.status).toBe('blocked');
    expect(r.session?.nextAgent).toBe('codex');
    expect(r.reason).toBe('blocked');
  });

  it('NEEDS_USER is downgraded to CONTINUE', () => {
    const s = session({ nextAgent: 'claude' });
    const r = applyAgentTurn(s, 'claude', 'COLLAB_STATUS: NEEDS_USER');
    expect(r.session?.status).toBe('active');
    expect(r.session?.lastStatus).toBe('CONTINUE');
  });

  it('reaching max rounds completes', () => {
    const s = session({ nextAgent: 'claude', round: 1, maxRounds: 2 });
    const r = applyAgentTurn(s, 'claude', 'CONTINUE');
    expect(r.session?.round).toBe(2);
    expect(r.session?.status).toBe('complete');
    expect(r.reason).toBe('max-rounds');
  });

  it('maxRounds 0 never hits the round cap', () => {
    const s = session({ nextAgent: 'claude', round: 99, maxRounds: 0 });
    const r = applyAgentTurn(s, 'claude', 'CONTINUE');
    expect(r.session?.status).toBe('active');
  });
});

describe('stopCollabSession', () => {
  it('marks stopped', () => {
    const r = stopCollabSession(session());
    expect(r.status).toBe('stopped');
    expect(r.endedReason).toBe('stopped');
  });
});

describe('parseCollabTextCommand', () => {
  it('returns null for non-collab text', () => {
    expect(parseCollabTextCommand('hello')).toBeNull();
  });
  it('parses stop', () => {
    expect(parseCollabTextCommand('./collab stop')).toEqual({ type: 'stop' });
  });
  it('parses explicit starters', () => {
    expect(parseCollabTextCommand('/collab 나붕봇 fix it')).toEqual({
      type: 'start',
      starter: 'codex',
      task: 'fix it',
    });
    expect(parseCollabTextCommand('/collab claude write docs')).toEqual({
      type: 'start',
      starter: 'claude',
      task: 'write docs',
    });
  });
  it('defaults to claude starter with the whole rest as task', () => {
    expect(parseCollabTextCommand('./collab investigate the bug')).toEqual({
      type: 'start',
      starter: 'claude',
      task: 'investigate the bug',
    });
  });
});

describe('prompt builders + helpers', () => {
  it('isCollabAgent narrows', () => {
    expect(isCollabAgent('claude')).toBe(true);
    expect(isCollabAgent('both')).toBe(false);
  });
  it('turn prompt carries task, round and protocol', () => {
    const p = buildCollabTurnPrompt({ agent: 'claude', task: 'T', round: 2, maxRounds: 10, conversation: 'C' });
    expect(p).toContain('재붕봇(Claude)');
    expect(p).toContain('Task: T');
    expect(p).toContain('round 2/10');
    expect(p).toContain('COLLAB_STATUS: DONE|CONTINUE|BLOCKED');
    expect(p.endsWith('C')).toBe(true);
  });
  it('kickoff message frames round 1', () => {
    const s = createCollabSession({ task: 'X', starter: 'codex', startedBy: 'discord:1', maxRounds: 0 });
    const k = buildCollabKickoffMessage(s);
    expect(k).toContain('나붕봇(Codex)');
    expect(k).toContain('unlimited');
  });
});
