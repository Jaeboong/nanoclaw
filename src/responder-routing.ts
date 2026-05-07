import { isClaudeResponder } from './responder-state.js';
import type { Responder } from './responder-state.js';
import { isTriggerAllowed } from './sender-allowlist.js';
import type { SenderAllowlistConfig } from './sender-allowlist.js';
import type { NewMessage } from './types.js';

export function hasAuthorizedTrigger(params: {
  chatJid: string;
  messages: NewMessage[];
  triggerPattern: RegExp;
  allowlist: SenderAllowlistConfig;
}): boolean {
  return params.messages.some(
    (m) =>
      params.triggerPattern.test(m.content.trim()) &&
      (m.is_from_me ||
        isTriggerAllowed(params.chatJid, m.sender, params.allowlist)),
  );
}

export function hasOtherBotMention(messages: NewMessage[]): boolean {
  return messages.some(
    (m) =>
      !m.mentions_self &&
      m.mentioned_bot_ids !== undefined &&
      m.mentioned_bot_ids.length > 0,
  );
}

export function shouldProcessForResponder(params: {
  responder: Responder;
  chatJid: string;
  messages: NewMessage[];
  triggerPattern: RegExp;
  allowlist: SenderAllowlistConfig;
}): boolean {
  if (hasOtherBotMention(params.messages)) {
    return false;
  }

  if (isClaudeResponder(params.responder)) {
    return true;
  }
  return hasAuthorizedTrigger(params);
}
