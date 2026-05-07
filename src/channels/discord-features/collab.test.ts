import fs from 'fs';
import os from 'os';
import path from 'path';

import { MessageFlags } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: false,
  })),
}));

import { getCollabMaxRounds, getCollabSession } from '../../collab-state.js';

import { collabFeature, handleCollabInteraction } from './collab.js';
import type { CollabFeatureContext, CollabInteraction } from './collab.js';

let tempDir: string;
let statePath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-collab-feature-'));
  statePath = path.join(tempDir, 'collab-state.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createInteraction(params: {
  mode?: string | null;
  agent?: string | null;
  task?: string | null;
  value?: number | null;
}): CollabInteraction {
  return {
    commandName: 'collab',
    channelId: '1234567890123456',
    user: { id: 'user-1', username: 'tester' },
    options: {
      getString: vi.fn((name: string) => {
        if (name === 'mode') return params.mode ?? null;
        if (name === 'agent') return params.agent ?? null;
        if (name === 'task') return params.task ?? null;
        return null;
      }),
      getInteger: vi.fn((name: string) =>
        name === 'value' ? (params.value ?? null) : null,
      ),
    },
    reply: vi.fn(async () => undefined),
  } satisfies CollabInteraction;
}

function createContext(): CollabFeatureContext {
  return {
    registeredGroups: () => ({
      'dc:1234567890123456': {
        name: 'Job',
        folder: 'job',
        trigger: '@재붕봇',
        added_at: '2026-05-07T00:00:00.000Z',
      },
    }),
    onMessage: vi.fn(),
  };
}

describe('collabFeature', () => {
  it('registers a collab slash command', () => {
    const commands = collabFeature.slashCommands();

    expect(commands.map((c) => c.name)).toContain('collab');
  });

  it('starts a Claude-first session by default and stores a synthetic task', async () => {
    const interaction = createInteraction({ task: '기업 분석해' });
    const ctx = createContext();

    const handled = await handleCollabInteraction(interaction, ctx, {
      statePath,
    });

    expect(handled).toBe(true);
    expect(getCollabSession('dc:1234567890123456', statePath)).toMatchObject({
      starter: 'claude',
      nextAgent: 'claude',
      task: '기업 분석해',
      maxRounds: 10,
    });
    expect(ctx.onMessage).toHaveBeenCalledWith(
      'dc:1234567890123456',
      expect.objectContaining({
        sender: 'user-1',
        is_bot_message: false,
        content: expect.stringContaining('COLLAB_STATUS'),
      }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('재붕봇부터 시작'),
      }),
    );
  });

  it('starts a Codex-first session when 나붕봇 is selected', async () => {
    const interaction = createInteraction({
      agent: 'codex',
      task: 'OpenClaw 점검해',
    });
    const ctx = createContext();

    await handleCollabInteraction(interaction, ctx, { statePath });

    expect(getCollabSession('dc:1234567890123456', statePath)).toMatchObject({
      starter: 'codex',
      nextAgent: 'codex',
      task: 'OpenClaw 점검해',
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('나붕봇부터 시작'),
      }),
    );
  });

  it('sets the channel max rounds with an ephemeral reply', async () => {
    const interaction = createInteraction({ mode: 'max', value: 5 });
    const ctx = createContext();

    await handleCollabInteraction(interaction, ctx, { statePath });

    expect(getCollabMaxRounds('dc:1234567890123456', statePath)).toBe(5);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: 'Collab max rounds changed to: 5',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('returns status and stops an active session', async () => {
    const ctx = createContext();
    await handleCollabInteraction(
      createInteraction({ task: '상태 테스트' }),
      ctx,
      { statePath },
    );

    const statusInteraction = createInteraction({ mode: 'status' });
    await handleCollabInteraction(statusInteraction, ctx, { statePath });
    expect(statusInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('active'),
        flags: MessageFlags.Ephemeral,
      }),
    );

    const stopInteraction = createInteraction({ mode: 'stop' });
    await handleCollabInteraction(stopInteraction, ctx, { statePath });
    expect(getCollabSession('dc:1234567890123456', statePath)).toMatchObject({
      status: 'stopped',
    });
  });
});
