import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCollabTurnPrompt,
  getCollabMaxRounds,
  hasExplicitCollabTurnStatus,
  parseCollabTextCommand,
  recordCollabAgentTurn,
  setCollabMaxRounds,
  shouldIncludeBotMessagesForCollabRecovery,
  startCollabSession,
  stopCollabSession,
} from './collab-state.js';

let tempDir: string;
let statePath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-collab-'));
  statePath = path.join(tempDir, 'collab-state.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('collab state', () => {
  it('starts a Claude-first session with default max rounds', () => {
    const session = startCollabSession(
      {
        chatJid: 'dc:channel',
        task: '기업 분석해',
        starter: 'claude',
        startedBy: 'user-1',
      },
      statePath,
    );

    expect(session.nextAgent).toBe('claude');
    expect(session.maxRounds).toBe(10);
    expect(session.round).toBe(0);
    expect(session.done).toEqual({ claude: false, codex: false });
    expect(
      JSON.parse(fs.readFileSync(statePath, 'utf8')).channels['dc:channel']
        .session,
    ).toMatchObject({
      task: '기업 분석해',
      status: 'active',
    });
  });

  it('stores per-channel max rounds and uses them for new sessions', () => {
    setCollabMaxRounds('dc:channel', 5, 'user-1', statePath);

    expect(getCollabMaxRounds('dc:channel', statePath)).toBe(5);
    expect(
      startCollabSession(
        {
          chatJid: 'dc:channel',
          task: '검증해',
          starter: 'codex',
          startedBy: 'user-1',
        },
        statePath,
      ).maxRounds,
    ).toBe(5);
  });

  it('advances turns and completes early after both agents declare DONE', () => {
    startCollabSession(
      {
        chatJid: 'dc:channel',
        task: '정리해',
        starter: 'claude',
        startedBy: 'user-1',
      },
      statePath,
    );

    const first = recordCollabAgentTurn(
      'dc:channel',
      'claude',
      '초안 완료\nCOLLAB_STATUS: DONE',
      statePath,
    );
    expect(first.session?.status).toBe('active');
    expect(first.session?.nextAgent).toBe('codex');

    const second = recordCollabAgentTurn(
      'dc:channel',
      'codex',
      '검증 완료\nCOLLAB_STATUS: DONE',
      statePath,
    );
    expect(second.session?.status).toBe('complete');
    expect(second.reason).toBe('both-done');
  });

  it('treats NEEDS_USER as a continuation instead of pausing the session', () => {
    startCollabSession(
      {
        chatJid: 'dc:channel',
        task: '노션 정리해',
        starter: 'claude',
        startedBy: 'user-1',
      },
      statePath,
    );

    const result = recordCollabAgentTurn(
      'dc:channel',
      'claude',
      '사용자 OK 받으면 진행\nCOLLAB_STATUS: NEEDS_USER',
      statePath,
    );

    expect(result.reason).toBe('continue');
    expect(result.session?.status).toBe('active');
    expect(result.session?.nextAgent).toBe('codex');
    expect(result.session?.lastStatus).toBe('CONTINUE');
  });

  it('completes when max rounds is reached before both agents are done', () => {
    setCollabMaxRounds('dc:channel', 2, 'user-1', statePath);
    startCollabSession(
      {
        chatJid: 'dc:channel',
        task: '검토해',
        starter: 'claude',
        startedBy: 'user-1',
      },
      statePath,
    );

    recordCollabAgentTurn(
      'dc:channel',
      'claude',
      '계속\nCOLLAB_STATUS: CONTINUE',
      statePath,
    );
    const result = recordCollabAgentTurn(
      'dc:channel',
      'codex',
      '더 검토 필요\nCOLLAB_STATUS: CONTINUE',
      statePath,
    );

    expect(result.session?.status).toBe('complete');
    expect(result.reason).toBe('max-rounds');
  });

  it('builds a protocol prompt for the current agent turn', () => {
    const prompt = buildCollabTurnPrompt({
      agent: 'codex',
      task: 'OpenClaw 점검',
      round: 2,
      maxRounds: 10,
      conversation: '재붕봇: 원인 후보 정리',
    });

    expect(prompt).toContain('OpenClaw 점검');
    expect(prompt).toContain('round 2/10');
    expect(prompt).toContain('COLLAB_STATUS: DONE|CONTINUE|BLOCKED');
    expect(prompt).toContain('Do not use NEEDS_USER');
    expect(prompt).toContain('재붕봇: 원인 후보 정리');
  });

  it('detects explicit collab turn status lines', () => {
    expect(hasExplicitCollabTurnStatus('작업함\nCOLLAB_STATUS: CONTINUE')).toBe(
      true,
    );
    expect(hasExplicitCollabTurnStatus('작업함\nDONE')).toBe(true);
    expect(hasExplicitCollabTurnStatus('Tidepooling...')).toBe(false);
    expect(hasExplicitCollabTurnStatus('일반적인 done 단어')).toBe(false);
  });

  it('includes bot messages during recovery only for an active Claude turn', () => {
    startCollabSession(
      {
        chatJid: 'dc:channel',
        task: 'handoff 복구',
        starter: 'claude',
        startedBy: 'user-1',
      },
      statePath,
    );

    expect(
      shouldIncludeBotMessagesForCollabRecovery('dc:channel', statePath),
    ).toBe(true);

    recordCollabAgentTurn(
      'dc:channel',
      'claude',
      '초안\nCOLLAB_STATUS: CONTINUE',
      statePath,
    );

    expect(
      shouldIncludeBotMessagesForCollabRecovery('dc:channel', statePath),
    ).toBe(false);

    recordCollabAgentTurn(
      'dc:channel',
      'codex',
      '검토\nCOLLAB_STATUS: CONTINUE',
      statePath,
    );

    expect(
      shouldIncludeBotMessagesForCollabRecovery('dc:channel', statePath),
    ).toBe(true);

    stopCollabSession('dc:channel', 'user-1', statePath);

    expect(
      shouldIncludeBotMessagesForCollabRecovery('dc:channel', statePath),
    ).toBe(false);
  });
});

describe('collab text commands', () => {
  it('parses simple start, selected starter, max, status, and stop commands', () => {
    expect(parseCollabTextCommand('/collab 기업 분석해')).toEqual({
      type: 'start',
      starter: 'claude',
      task: '기업 분석해',
    });
    expect(parseCollabTextCommand('/collab 나붕봇 OpenClaw 점검')).toEqual({
      type: 'start',
      starter: 'codex',
      task: 'OpenClaw 점검',
    });
    expect(parseCollabTextCommand('/collab max 5')).toEqual({
      type: 'max',
      maxRounds: 5,
    });
    expect(parseCollabTextCommand('/collab status')).toEqual({
      type: 'status',
    });
    expect(parseCollabTextCommand('/collab stop')).toEqual({ type: 'stop' });
    expect(parseCollabTextCommand('/not-collab')).toBeNull();
  });

  it('marks a stopped session as stopped', () => {
    startCollabSession(
      {
        chatJid: 'dc:channel',
        task: '멈춤 테스트',
        starter: 'claude',
        startedBy: 'user-1',
      },
      statePath,
    );

    const stopped = stopCollabSession('dc:channel', 'user-1', statePath);

    expect(stopped?.status).toBe('stopped');
  });
});
