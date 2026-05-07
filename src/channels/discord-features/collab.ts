import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
} from 'discord.js';

import {
  buildCollabKickoffMessage,
  startCollabSession,
  type CollabAgent,
} from '../../collab-state.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
} from '../../sender-allowlist.js';

import type {
  DiscordFeature,
  DiscordFeatureContext,
  SlashCommandJSON,
} from './feature.js';

type CollabReply = InteractionReplyOptions & {
  readonly content: string;
};

export interface CollabInteraction {
  readonly commandName: string;
  readonly channelId: string;
  readonly user: { readonly id: string; readonly username?: string };
  readonly options: {
    getString(name: string): string | null;
    getInteger(name: string): number | null;
  };
  reply(options: CollabReply): Promise<unknown>;
}

export type CollabFeatureContext = Pick<
  DiscordFeatureContext,
  'registeredGroups' | 'onMessage'
>;

type HandlerOptions = {
  readonly statePath?: string;
};

const AGENT_CHOICES: readonly { name: string; value: CollabAgent }[] = [
  { name: 'Codex', value: 'codex' },
  { name: 'Claude', value: 'claude' },
];

function isCollabAgent(value: string | null): value is CollabAgent {
  return value === 'claude' || value === 'codex';
}

function slashCommands(): SlashCommandJSON[] {
  return [
    new SlashCommandBuilder()
      .setName('collab')
      .setDescription('Start a bounded Claude/Codex collaboration')
      .addStringOption((opt) =>
        opt
          .setName('task')
          .setDescription('Natural language task for the collaboration')
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('start')
          .setDescription('Starting agent; default is Claude')
          .setRequired(false)
          .addChoices(...AGENT_CHOICES),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('max')
          .setDescription('Max rounds for this collaboration')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(50),
      )
      .toJSON(),
  ];
}

function agentDisplayName(agent: CollabAgent): string {
  return agent === 'claude' ? '재붕봇' : '나붕봇';
}

function formatStartReply(params: {
  readonly starter: CollabAgent;
  readonly maxRounds: number;
}): string {
  return `Collab started. Starter: ${agentDisplayName(params.starter)}. Max rounds: ${params.maxRounds}.`;
}

export async function handleCollabInteraction(
  interaction: CollabInteraction,
  ctx: CollabFeatureContext,
  options: HandlerOptions = {},
): Promise<boolean> {
  if (interaction.commandName !== 'collab') return false;

  const chatJid = `dc:${interaction.channelId}`;
  if (!ctx.registeredGroups()[chatJid]) {
    await interaction.reply({
      content: 'Collab command ignored: unregistered channel.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const allowlistCfg = loadSenderAllowlist();
  if (!isSenderAllowed(chatJid, interaction.user.id, allowlistCfg)) {
    await interaction.reply({
      content: 'Collab command denied.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const task = interaction.options.getString('task')?.trim() ?? '';
  if (!task) {
    await interaction.reply({
      content: 'Usage: /collab task:<natural language task>',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const requestedAgent = interaction.options.getString('start');
  const starter = isCollabAgent(requestedAgent) ? requestedAgent : 'claude';
  const requestedMaxRounds = interaction.options.getInteger('max');
  const session = startCollabSession(
    {
      chatJid,
      task,
      starter,
      startedBy: interaction.user.id,
      ...(requestedMaxRounds !== null ? { maxRounds: requestedMaxRounds } : {}),
    },
    options.statePath,
  );
  const kickoff = buildCollabKickoffMessage(session);

  ctx.onMessage(chatJid, {
    id: `collab:${session.id}:start`,
    chat_jid: chatJid,
    sender: interaction.user.id,
    sender_name: interaction.user.username ?? interaction.user.id,
    content: kickoff,
    timestamp: session.startedAt,
    is_from_me: false,
    is_bot_message: false,
  });

  await interaction.reply({
    content: formatStartReply({
      starter: session.starter,
      maxRounds: session.maxRounds,
    }),
  });
  return true;
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  ctx: DiscordFeatureContext,
): Promise<boolean> {
  return handleCollabInteraction(
    {
      commandName: interaction.commandName,
      channelId: interaction.channelId,
      user: {
        id: interaction.user.id,
        username: interaction.user.username,
      },
      options: {
        getString: (name) => interaction.options.getString(name),
        getInteger: (name) => interaction.options.getInteger(name),
      },
      reply: (replyOptions) => interaction.reply(replyOptions),
    },
    ctx,
  );
}

export const collabFeature: DiscordFeature = {
  name: 'collab',
  slashCommands,
  handleCommand,
};
