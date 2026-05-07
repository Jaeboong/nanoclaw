import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: false,
  })),
}));

import { getCollabSession } from '../../collab-state.js';

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
  start?: string | null;
  task?: string | null;
  max?: number | null;
}): CollabInteraction {
  return {
    commandName: 'collab',
    channelId: '1234567890123456',
    user: { id: 'user-1', username: 'tester' },
    options: {
      getString: vi.fn((name: string) => {
        if (name === 'start') return params.start ?? null;
        if (name === 'task') return params.task ?? null;
        return null;
      }),
      getInteger: vi.fn((name: string) =>
        name === 'max' ? (params.max ?? null) : null,
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
    const commandJson = commands[0];
    const optionNames = commandJson.options?.map((option) => option.name);

    expect(commands.map((c) => c.name)).toContain('collab');
    expect(optionNames).toEqual(['task', 'start', 'max']);
  });

  it('starts a Claude-first session by default and keeps protocol hidden from Discord', async () => {
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
        content: expect.stringContaining('Collab started'),
      }),
    );
    expect(interaction.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('COLLAB_STATUS'),
      }),
    );
  });

  it('starts a Codex-first session when 나붕봇 is selected', async () => {
    const interaction = createInteraction({
      start: 'codex',
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
        content: expect.stringContaining('Starter: 나붕봇'),
      }),
    );
  });

  it('uses max as the current session round limit', async () => {
    const interaction = createInteraction({ task: '짧게 협업해', max: 5 });
    const ctx = createContext();

    await handleCollabInteraction(interaction, ctx, { statePath });

    expect(getCollabSession('dc:1234567890123456', statePath)).toMatchObject({
      task: '짧게 협업해',
      maxRounds: 5,
    });
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Max rounds: 5'),
      }),
    );
  });
});
