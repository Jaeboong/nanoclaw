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
// Feature modules self-register their slash commands / component handlers on
// import (side-effect). Add Task-8+ feature imports here so they populate the
// interaction registry before registerSlashCommandsWithDiscord runs below.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
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
    });
  },
});
