import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Message,
  MessageType,
  TextChannel,
  type Interaction,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  formatAttachmentReference,
  saveAttachment,
} from './discord-attachments.js';
import type {
  DiscordFeature,
  DiscordFeatureContext,
} from './discord-features/feature.js';
import {
  createJiraFeature,
  type JiraFeature,
} from './discord-features/jira.js';
import { runtimeControlFeature } from './discord-features/runtime-control.js';
import { buildEmbedsForMessage } from './discord-sections.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MessageMetadata,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface DiscordChannelConfig {
  exactJids?: readonly string[];
  name?: string;
}

export class DiscordChannel implements Channel {
  name: string;

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private features: readonly DiscordFeature[];
  private exactJids: ReadonlySet<string> | null;
  // jid → status message id currently being edited in place.
  // Populated by sendStatus, cleared (with delete()) at sendMessage entry.
  private statusMessages = new Map<string, string>();

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    features: readonly DiscordFeature[],
    config: DiscordChannelConfig = {},
  ) {
    this.name = config.name ?? 'discord';
    this.botToken = botToken;
    this.opts = opts;
    this.features = features;
    this.exactJids = config.exactJids ? new Set(config.exactJids) : null;
  }

  getFeature<T extends DiscordFeature = DiscordFeature>(
    name: string,
  ): T | undefined {
    return this.features.find((f) => f.name === name) as T | undefined;
  }

  private buildFeatureContext(): DiscordFeatureContext {
    return {
      client: this.client!,
      registeredGroups: this.opts.registeredGroups,
      onMessage: this.opts.onMessage,
      onChatMetadata: this.opts.onChatMetadata,
    };
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Auto-delete the system "X pinned a message" notification when WE pin.
      // Eliminates pin-spam in the work-ledger panel channel after every refresh.
      if (
        message.type === MessageType.ChannelPinnedMessage &&
        message.author.id === this.client?.user?.id
      ) {
        try {
          await message.delete();
        } catch {
          /* ignore — already gone or no perms */
        }
        return;
      }
      // Block ONLY the assistant's own messages (prevents self-trigger loop).
      // Other bots are allowed through as is_external_bot=true: stored for
      // context but filtered from trigger polling so they never auto-reply.
      if (message.author.id === this.client?.user?.id) return;
      const isExternalBot = message.author.bot;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      // External bots (including other nanoclaw instances) often deliver text
      // via embeds rather than message.content — buildEmbedsForMessage wraps
      // even plain replies in a white embed, leaving content="". Harvest the
      // visible text so the agent reading this message can actually see it.
      if (isExternalBot && !content.trim()) {
        const parts: string[] = [];
        for (const embed of message.embeds) {
          if (embed.title) parts.push(embed.title);
          if (embed.description) parts.push(embed.description);
          if (embed.fields?.length) {
            for (const f of embed.fields) parts.push(`${f.name}: ${f.value}`);
          }
          if (embed.footer?.text) parts.push(`(${embed.footer.text})`);
        }
        for (const sticker of message.stickers.values()) {
          parts.push(`[sticker: ${sticker.name}]`);
        }
        for (const att of message.attachments.values()) {
          parts.push(`[attachment: ${att.name ?? att.url}]`);
        }
        content = parts.filter(Boolean).join('\n');
      }
      const timestamp = message.createdAt.toISOString();
      const rawSenderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      // Prefix external bot names so the LLM clearly distinguishes them from
      // human participants when reading conversation context.
      const senderName = isExternalBot ? `🤖 ${rawSenderName}` : rawSenderName;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Skip for external bots — we never want another bot's @mention of us
      // to look like a trigger (defense in depth on top of the polling filter).
      if (this.client?.user && !isExternalBot) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Download attachments to group inbox so the agent can read them.
      // Skip for external bots to avoid disk fill from unrelated bot uploads.
      if (message.attachments.size > 0 && !isExternalBot) {
        const results = await Promise.all(
          [...message.attachments.values()].map((att) =>
            saveAttachment(
              {
                url: att.url,
                name: att.name,
                size: att.size,
                contentType: att.contentType,
              },
              group.folder,
            ),
          ),
        );
        const refs = results
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .map(formatAttachmentReference);
        if (refs.length > 0) {
          content = content
            ? `${content}\n${refs.join('\n')}`
            : refs.join('\n');
        }
        const dropped = results.filter((r) => r === null).length;
        if (dropped > 0) {
          content =
            `${content}\n[${dropped} attachment(s) could not be saved]`.trim();
        }
      }

      // Deliver message — startMessageLoop() will pick it up.
      // External bots are stored for context but excluded from trigger polling
      // (getNewMessages filters is_external_bot=0).
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_external_bot: isExternalBot,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );

      // Panel channel (work-ledger): keep clean by deleting user messages
      // immediately after they're stored. Bot messages (panels/ephemerals)
      // are handled separately.
      if (group.folder === 'discord_notes' && !message.author.bot) {
        try {
          await message.delete();
        } catch (err) {
          logger.warn(
            { err, msgId },
            'Failed to delete user message in panel channel',
          );
        }
      }
    });

    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    this.client.on(
      Events.InteractionCreate,
      async (interaction: Interaction) => {
        const ctx = this.buildFeatureContext();

        if (interaction.isButton()) {
          for (const f of this.features) {
            if (!f.handleButton) continue;
            const handled = await f.handleButton(interaction, ctx);
            if (handled) return;
          }
          return;
        }
        if (interaction.isStringSelectMenu()) {
          for (const f of this.features) {
            if (!f.handleSelect) continue;
            const handled = await f.handleSelect(interaction, ctx);
            if (handled) return;
          }
          return;
        }
        if (interaction.isModalSubmit()) {
          for (const f of this.features) {
            if (!f.handleModal) continue;
            const handled = await f.handleModal(interaction, ctx);
            if (handled) return;
          }
          return;
        }
        if (interaction.isChatInputCommand()) {
          for (const f of this.features) {
            if (!f.handleCommand) continue;
            const handled = await f.handleCommand(interaction, ctx);
            if (handled) return;
          }
          return;
        }
      },
    );

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          {
            channel: this.name,
            username: readyClient.user.tag,
            id: readyClient.user.id,
          },
          'Discord bot connected',
        );
        for (const f of this.features) {
          if (!f.onReady) continue;
          try {
            await f.onReady({ client: this.client! });
          } catch (err) {
            logger.warn({ err, feature: f.name }, 'feature onReady failed');
          }
        }
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        try {
          await this.registerSlashCommands();
        } catch (err) {
          logger.error({ err }, 'Failed to register slash commands');
        }
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  private collectSlashCommands() {
    return this.features.flatMap((f) => f.slashCommands());
  }

  private async registerSlashCommands(): Promise<void> {
    if (!this.client?.application) return;
    const commands = this.collectSlashCommands();

    // Clear lingering global registrations from older versions.
    try {
      await this.client.application.commands.set([]);
      logger.info('Cleared global slash command registrations');
    } catch (err) {
      logger.warn({ err }, 'Failed to clear global slash commands');
    }

    for (const [guildId, guild] of this.client.guilds.cache) {
      try {
        await guild.commands.set(commands);
        logger.info(
          { guildId, guildName: guild.name, count: commands.length },
          'Slash commands registered for guild',
        );
      } catch (err) {
        logger.warn(
          { guildId, err },
          'Failed to register slash commands for guild',
        );
      }
    }

    this.client.on(Events.GuildCreate, async (guild) => {
      try {
        await guild.commands.set(commands);
        logger.info(
          { guildId: guild.id, guildName: guild.name },
          'Slash commands registered for newly-joined guild',
        );
      } catch (err) {
        logger.warn(
          { guildId: guild.id, err },
          'Failed to register slash commands for new guild',
        );
      }
    });
  }

  async sendStatus(jid: string, text: string): Promise<void> {
    if (!this.client) return;

    const formatted = `*${text}*`.slice(0, 2000);

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return;
      const textChannel = channel as TextChannel;

      const existingId = this.statusMessages.get(jid);
      if (existingId) {
        try {
          const existing = await textChannel.messages.fetch(existingId);
          await existing.edit({ content: formatted });
          return;
        } catch {
          this.statusMessages.delete(jid);
        }
      }

      const sent = await textChannel.send({ content: formatted });
      this.statusMessages.set(jid, sent.id);
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord status');
    }
  }

  private async clearStatus(
    jid: string,
    textChannel: TextChannel,
  ): Promise<void> {
    const existingId = this.statusMessages.get(jid);
    if (!existingId) return;
    this.statusMessages.delete(jid);
    try {
      const existing = await textChannel.messages.fetch(existingId);
      await existing.delete();
    } catch {
      // Already gone — nothing to do.
    }
  }

  async sendMessage(
    jid: string,
    text: string,
    files?: string[],
    metadata?: MessageMetadata,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;
      await this.clearStatus(jid, textChannel);

      // Panel channel (work-ledger): TTL-delete the bot's own response
      // messages so the channel stays focused on the pinned panels.
      const groupForJid = this.opts.registeredGroups()[jid];
      const isPanelChannel = groupForJid?.folder === 'discord_notes';
      const inboundFiles =
        files && files.length > 0
          ? files.map((f) => new AttachmentBuilder(f))
          : [];

      const {
        embeds,
        overflowText,
        attachments: tableAttachments,
      } = await buildEmbedsForMessage(text, metadata);

      const firstBatchFiles = [...inboundFiles, ...tableAttachments];

      const sentMessages: Message[] = [];

      if (embeds.length === 0) {
        if (firstBatchFiles.length > 0) {
          const m = await textChannel.send({ files: firstBatchFiles });
          sentMessages.push(m);
        }
        if (isPanelChannel) this.scheduleEphemeralDelete(sentMessages);
        return;
      }

      const EMBEDS_PER_MESSAGE = 10;
      for (let i = 0; i < embeds.length; i += EMBEDS_PER_MESSAGE) {
        const batch = embeds.slice(i, i + EMBEDS_PER_MESSAGE);
        const payload: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] } =
          { embeds: batch };
        if (i === 0 && firstBatchFiles.length > 0) {
          payload.files = firstBatchFiles;
        }
        const m = await textChannel.send(payload);
        sentMessages.push(m);
      }

      if (overflowText) {
        const MAX_LENGTH = 2000;
        for (let i = 0; i < overflowText.length; i += MAX_LENGTH) {
          const m = await textChannel.send(
            overflowText.slice(i, i + MAX_LENGTH),
          );
          sentMessages.push(m);
        }
      }

      if (isPanelChannel) this.scheduleEphemeralDelete(sentMessages);

      logger.info(
        {
          jid,
          length: text.length,
          embedCount: embeds.length,
          overflowChars: overflowText.length,
          fileCount: firstBatchFiles.length,
          tableCount: tableAttachments.length,
        },
        'Discord message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  /**
   * Auto-delete bot response messages after a TTL. Used in the panel channel
   * to keep the conversation focused on the pinned work-ledger panels.
   */
  private scheduleEphemeralDelete(messages: Message[]): void {
    const TTL_MS = 60_000;
    for (const m of messages) {
      setTimeout(() => {
        m.delete().catch((err) => {
          logger.debug(
            { err, id: m.id },
            'Panel channel auto-delete failed (already gone?)',
          );
        });
      }, TTL_MS);
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  matchJid(jid: string): number {
    if (this.exactJids) {
      return this.exactJids.has(jid) ? 2 : 0;
    }
    return jid.startsWith('dc:') ? 1 : 0;
  }

  ownsJid(jid: string): boolean {
    return this.matchJid(jid) > 0;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info({ channel: this.name }, 'Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'DISCORD_BOT_TOKEN',
    'DISCORD_JIRA_PANEL_CHANNEL_ID',
  ]);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }

  const panelChannelId =
    process.env.DISCORD_JIRA_PANEL_CHANNEL_ID ||
    envVars.DISCORD_JIRA_PANEL_CHANNEL_ID ||
    '';

  const features: DiscordFeature[] = [runtimeControlFeature];
  if (panelChannelId) {
    features.push(createJiraFeature({ panelChannelId }));
  } else {
    logger.warn(
      'DISCORD_JIRA_PANEL_CHANNEL_ID not set — jira feature disabled',
    );
  }

  return new DiscordChannel(token, opts, features);
});

export type { JiraFeature };
