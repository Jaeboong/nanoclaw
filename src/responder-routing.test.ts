import { describe, expect, it } from 'vitest';

import {
  hasAuthorizedTrigger,
  shouldProcessForResponder,
} from './responder-routing.js';
import type { SenderAllowlistConfig } from './sender-allowlist.js';
import type { NewMessage } from './types.js';

const allowAll: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: false,
};

function msg(
  overrides: Partial<NewMessage> & Record<string, unknown> = {},
): NewMessage {
  return {
    id: '1',
    chat_jid: 'dc:channel',
    sender: 'user-1',
    sender_name: 'User',
    content: 'hello',
    timestamp: '2026-05-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('responder routing', () => {
  const triggerPattern = /^@Andy\b/i;

  it('allows Claude when responder selects Claude', () => {
    expect(
      shouldProcessForResponder({
        responder: 'claude',
        chatJid: 'dc:channel',
        messages: [msg()],
        triggerPattern,
        allowlist: allowAll,
      }),
    ).toBe(true);
  });

  it('blocks Claude when responder selects Codex and no trigger is present', () => {
    expect(
      shouldProcessForResponder({
        responder: 'codex',
        chatJid: 'dc:channel',
        messages: [msg()],
        triggerPattern,
        allowlist: allowAll,
      }),
    ).toBe(false);
  });

  it('allows Claude when directly triggered even if responder selects Codex', () => {
    expect(
      shouldProcessForResponder({
        responder: 'codex',
        chatJid: 'dc:channel',
        messages: [msg({ content: '@Andy answer this' })],
        triggerPattern,
        allowlist: allowAll,
      }),
    ).toBe(true);
  });

  it('blocks Claude on another bot mention even when responder selects Claude', () => {
    expect(
      shouldProcessForResponder({
        responder: 'claude',
        chatJid: 'dc:channel',
        messages: [
          msg({
            content: '<@bot-2> answer this',
            mentioned_bot_ids: ['bot-2'],
            mentions_self: false,
          }),
        ],
        triggerPattern,
        allowlist: allowAll,
      }),
    ).toBe(false);
  });

  it('allows Claude on its own bot mention even when responder selects Codex', () => {
    expect(
      shouldProcessForResponder({
        responder: 'codex',
        chatJid: 'dc:channel',
        messages: [
          msg({
            content: '@Andy answer this',
            mentioned_bot_ids: ['bot-1'],
            mentions_self: true,
          }),
        ],
        triggerPattern,
        allowlist: allowAll,
      }),
    ).toBe(true);
  });

  it('does not treat denied sender triggers as authorized', () => {
    const allowlist: SenderAllowlistConfig = {
      ...allowAll,
      chats: {
        'dc:channel': { allow: ['user-2'], mode: 'trigger' },
      },
    };

    expect(
      hasAuthorizedTrigger({
        chatJid: 'dc:channel',
        messages: [msg({ content: '@Andy answer this', sender: 'user-1' })],
        triggerPattern,
        allowlist,
      }),
    ).toBe(false);
  });
});
