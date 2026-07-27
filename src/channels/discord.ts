/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createChatSdkBridge, setForwardedInteractionRouter, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { registerSlashCommandsWithDiscord, routeForwardedInteraction } from './discord-interactions.js';
import { renderOutboundTables } from './discord-features/table-outbound.js';
import { deliverSectionEmbeds } from './discord-features/section-outbound.js';
// Feature modules self-register their slash commands / component handlers on
// import (side-effect), populating the interaction registry before
// registerSlashCommandsWithDiscord runs below.
import './discord-features/runtime-control.js';
import './discord-features/thread-command.js';
import { suppressMentionAutoThread } from './discord-features/suppress-mention-thread.js';

// Our own agent replies are delivered as colored embeds with empty message
// `content` (see section-outbound), so when a message quotes one, its text
// lives in the embed description, not `content`. Mirrors the v1 fork's
// extractEmbedText so reply context isn't blanked out.
function extractEmbedText(embeds: readonly unknown[] | undefined): string {
  if (!Array.isArray(embeds)) return '';
  for (const e of embeds) {
    const desc = (e as { description?: unknown })?.description;
    if (typeof desc === 'string' && desc.trim()) return desc;
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || extractEmbedText(reply.embeds) || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    const discordAdapter = createDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      publicKey: env.DISCORD_PUBLIC_KEY,
      applicationId: env.DISCORD_APPLICATION_ID,
    });
    // Additive: disable the upstream adapter's auto-thread-on-mention so mentions
    // answer in the root channel. On-demand threads come from /thread instead.
    suppressMentionAutoThread(discordAdapter);
    const botToken = env.DISCORD_BOT_TOKEN;
    const applicationId = env.DISCORD_APPLICATION_ID ?? '';

    // Route forwarded gateway interactions (slash + non-ncq components) into
    // the additive interaction module, and register slash commands with
    // Discord (best-effort, REST — independent of the gateway connection).
    setForwardedInteractionRouter(routeForwardedInteraction);
    void registerSlashCommandsWithDiscord(applicationId, botToken).catch((err) => {
      log.warn('Discord slash command registration failed', { err });
    });

    return createChatSdkBridge({
      adapter: discordAdapter,
      concurrency: 'concurrent',
      botToken,
      extractReplyContext,
      supportsThreads: true,
      // Render each agent reply as colored section embeds (the v1 흰/초록/파랑/
      // 빨강/노랑/회색 칸 look) posted via Discord REST, since the card path can
      // only emit a single hard-coded-color embed (additive module via the
      // generic deliverRichMessage seam). Falls back to the markdown path below.
      deliverRichMessage: (msg) => deliverSectionEmbeds(msg),
      // Fallback when rich delivery no-ops/fails: render CJK markdown tables to
      // PNG attachments so wide glyphs don't misalign (additive module via the
      // generic transformOutboundMessage seam).
      transformOutboundMessage: renderOutboundTables,
    });
  },
});
