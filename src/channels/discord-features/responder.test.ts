import { describe, expect, it, vi } from 'vitest';

vi.mock('../../sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: false,
  })),
}));

vi.mock('../../responder-state.js', () => ({
  getResponder: vi.fn(() => 'claude'),
  setResponder: vi.fn(),
}));

import { getResponder, setResponder } from '../../responder-state.js';

import { handleResponderInteraction, responderFeature } from './responder.js';
import type {
  ResponderFeatureContext,
  ResponderInteraction,
} from './responder.js';

function createInteraction(mode: string | null): ResponderInteraction {
  return {
    commandName: 'responder',
    channelId: '1234567890123456',
    user: { id: 'user-1' },
    options: {
      getString: vi.fn(() => mode),
    },
    reply: vi.fn(async () => undefined),
  } satisfies ResponderInteraction;
}

const ctx = {
  registeredGroups: () => ({
    'dc:1234567890123456': {
      name: 'Test',
      folder: 'test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    },
  }),
} satisfies ResponderFeatureContext;

describe('responderFeature', () => {
  it('registers a responder slash command', () => {
    const commands = responderFeature.slashCommands();

    expect(commands.map((c) => c.name)).toContain('responder');
  });

  it('returns current responder when mode is omitted', async () => {
    const interaction = createInteraction(null);

    const handled = await handleResponderInteraction(interaction, ctx);

    expect(handled).toBe(true);
    expect(getResponder).toHaveBeenCalledWith('dc:1234567890123456');
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('claude'),
      }),
    );
  });

  it('sets responder when mode is provided', async () => {
    const interaction = createInteraction('codex');

    const handled = await handleResponderInteraction(interaction, ctx);

    expect(handled).toBe(true);
    expect(setResponder).toHaveBeenCalledWith(
      'dc:1234567890123456',
      'codex',
      'user-1',
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('codex'),
      }),
    );
  });

  it('rejects invalid responder modes defensively', async () => {
    const interaction = createInteraction('gpt');

    const handled = await handleResponderInteraction(interaction, ctx);

    expect(handled).toBe(true);
    expect(setResponder).not.toHaveBeenCalledWith(
      'dc:1234567890123456',
      'gpt',
      'user-1',
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Usage:'),
      }),
    );
  });
});
