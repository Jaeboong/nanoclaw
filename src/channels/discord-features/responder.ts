import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
} from 'discord.js';

import {
  getResponder,
  setResponder,
  type Responder,
} from '../../responder-state.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
} from '../../sender-allowlist.js';

import type {
  DiscordFeature,
  DiscordFeatureContext,
  SlashCommandJSON,
} from './feature.js';

type ResponderReply = InteractionReplyOptions & {
  readonly content: string;
  readonly flags: MessageFlags.Ephemeral;
};

export interface ResponderInteraction {
  readonly commandName: string;
  readonly channelId: string;
  readonly user: { readonly id: string };
  readonly options: { getString(name: string): string | null };
  reply(options: ResponderReply): Promise<unknown>;
}

export type ResponderFeatureContext = Pick<
  DiscordFeatureContext,
  'registeredGroups'
>;

const RESPONDER_CHOICES: readonly { name: string; value: Responder }[] = [
  { name: 'Claude', value: 'claude' },
  { name: 'Codex', value: 'codex' },
  { name: 'Both', value: 'both' },
];

function isResponderMode(value: string): value is Responder {
  return value === 'claude' || value === 'codex' || value === 'both';
}

function slashCommands(): SlashCommandJSON[] {
  return [
    new SlashCommandBuilder()
      .setName('responder')
      .setDescription('View or change this channel responder')
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Responder mode; omit to view current setting')
          .setRequired(false)
          .addChoices(...RESPONDER_CHOICES),
      )
      .toJSON(),
  ];
}

export async function handleResponderInteraction(
  interaction: ResponderInteraction,
  ctx: ResponderFeatureContext,
): Promise<boolean> {
  if (interaction.commandName !== 'responder') return false;

  const chatJid = `dc:${interaction.channelId}`;
  if (!ctx.registeredGroups()[chatJid]) {
    await interaction.reply({
      content: 'This channel is not registered with NanoClaw.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const allowlistCfg = loadSenderAllowlist();
  if (!isSenderAllowed(chatJid, interaction.user.id, allowlistCfg)) {
    await interaction.reply({
      content: 'Responder command denied.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const mode = interaction.options.getString('mode');
  if (mode === null) {
    await interaction.reply({
      content: `Current responder: ${getResponder(chatJid)}`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!isResponderMode(mode)) {
    await interaction.reply({
      content: 'Usage: /responder [claude|codex|both]',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  setResponder(chatJid, mode, interaction.user.id);
  await interaction.reply({
    content: `Responder changed to: ${mode}`,
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  ctx: DiscordFeatureContext,
): Promise<boolean> {
  return handleResponderInteraction(
    {
      commandName: interaction.commandName,
      channelId: interaction.channelId,
      user: { id: interaction.user.id },
      options: {
        getString: (name) => interaction.options.getString(name),
      },
      reply: (options) => interaction.reply(options),
    },
    ctx,
  );
}

export const responderFeature: DiscordFeature = {
  name: 'responder',
  slashCommands,
  handleCommand,
};
