import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

import { createGrafanaSummaryFeature } from './discord-features/grafana-summary.js';
import { responderFeature } from './discord-features/responder.js';
import { runtimeControlFeature } from './discord-features/runtime-control.js';
import { DiscordChannel } from './discord.js';
import { ChannelOpts, registerChannel } from './registry.js';

registerChannel('discord-monitoring', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'DISCORD_BOT_TOKEN_MONITORING',
    'WEBHOOK_GRAFANA_JID',
  ]);
  const token =
    process.env.DISCORD_BOT_TOKEN_MONITORING ||
    envVars.DISCORD_BOT_TOKEN_MONITORING ||
    '';
  if (!token) {
    logger.warn(
      'Discord monitoring: DISCORD_BOT_TOKEN_MONITORING not set — skipping',
    );
    return null;
  }

  const grafanaJid =
    process.env.WEBHOOK_GRAFANA_JID || envVars.WEBHOOK_GRAFANA_JID || '';
  if (!grafanaJid) {
    logger.warn('Discord monitoring: WEBHOOK_GRAFANA_JID not set — skipping');
    return null;
  }

  return new DiscordChannel(
    token,
    opts,
    [
      runtimeControlFeature,
      responderFeature,
      createGrafanaSummaryFeature({ grafanaJid }),
    ],
    {
      exactJids: [grafanaJid],
      name: 'discord-monitoring',
    },
  );
});
