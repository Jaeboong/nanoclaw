import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
} from 'discord.js';

import {
  buildCollabKickoffMessage,
  getCollabMaxRounds,
  getCollabSession,
  setCollabMaxRounds,
  startCollabSession,
  stopCollabSession,
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
  { name: '재붕봇 / Claude', value: 'claude' },
  { name: '나붕봇 / Codex', value: 'codex' },
];

function isCollabAgent(value: string | null): value is CollabAgent {
  return value === 'claude' || value === 'codex';
}

function slashCommands(): SlashCommandJSON[] {
  return [
    new SlashCommandBuilder()
      .setName('collab')
      .setDescription('Start or control a bounded Claude/Codex collaboration')
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Control mode; omit to start when task is present')
          .setRequired(false)
          .addChoices(
            { name: 'start', value: 'start' },
            { name: 'max', value: 'max' },
            { name: 'status', value: 'status' },
            { name: 'stop', value: 'stop' },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName('agent')
          .setDescription('Starting agent; default is 재붕봇')
          .setRequired(false)
          .addChoices(...AGENT_CHOICES),
      )
      .addStringOption((opt) =>
        opt
          .setName('task')
          .setDescription('Natural language task for the collaboration')
          .setRequired(false),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('value')
          .setDescription('Value for mode=max')
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(50),
      )
      .toJSON(),
  ];
}

function formatStatus(chatJid: string, statePath?: string): string {
  const session = getCollabSession(chatJid, statePath);
  const maxRounds = getCollabMaxRounds(chatJid, statePath);
  if (!session) {
    return `Collab inactive. Default max rounds: ${maxRounds}`;
  }
  return [
    `Collab status: ${session.status}`,
    `Task: ${session.task}`,
    `Next: ${session.nextAgent}`,
    `Rounds: ${session.round}/${session.maxRounds}`,
    `Done: claude=${session.done.claude}, codex=${session.done.codex}`,
  ].join('\n');
}

function isStartMode(mode: string | null): boolean {
  return mode === null || mode === 'start';
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

  const mode = interaction.options.getString('mode');
  const task = interaction.options.getString('task')?.trim() ?? '';
  if (mode === 'status' || (mode === null && !task)) {
    await interaction.reply({
      content: formatStatus(chatJid, options.statePath),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (mode === 'stop') {
    const stopped = stopCollabSession(
      chatJid,
      interaction.user.id,
      options.statePath,
    );
    await interaction.reply({
      content: stopped ? 'Collab stopped.' : 'Collab is not active.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (mode === 'max') {
    const value = interaction.options.getInteger('value');
    if (value === null) {
      await interaction.reply({
        content: 'Usage: /collab mode:max value:<rounds>',
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const maxRounds = setCollabMaxRounds(
      chatJid,
      value,
      interaction.user.id,
      options.statePath,
    );
    await interaction.reply({
      content: `Collab max rounds changed to: ${maxRounds}`,
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!isStartMode(mode)) {
    await interaction.reply({
      content: 'Usage: /collab [agent] task:<natural language task>',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (!task) {
    await interaction.reply({
      content: 'Usage: /collab task:<natural language task>',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const requestedAgent = interaction.options.getString('agent');
  const starter = isCollabAgent(requestedAgent) ? requestedAgent : 'claude';
  const session = startCollabSession(
    {
      chatJid,
      task,
      starter,
      startedBy: interaction.user.id,
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

  await interaction.reply({ content: kickoff });
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
