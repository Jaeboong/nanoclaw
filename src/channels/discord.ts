import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Message,
  SlashCommandBuilder,
  TextChannel,
  type Interaction,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  DEFAULT_SENTINEL,
  EFFORT_CHOICES,
  MODEL_CHOICES,
  effortLabel,
  loadRuntimeSettings,
  modelLabel,
  updateRuntimeSettings,
} from '../group-runtime-settings.js';
import {
  formatAttachmentReference,
  saveAttachment,
} from './discord-attachments.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MessageMetadata,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { buildEmbedsForMessage } from './discord-sections.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  // jid → status message id currently being edited in place.
  // Populated by sendStatus, cleared (with delete()) at sendMessage entry.
  private statusMessages = new Map<string, string>();
  // Channel JID for the Grafana monitoring group. /daily /weekly /monthly
  // slash commands are restricted to this channel. Null = commands disabled.
  private grafanaJid: string | null;

  constructor(botToken: string, opts: DiscordChannelOpts, grafanaJid?: string) {
    this.botToken = botToken;
    this.opts = opts;
    this.grafanaJid = grafanaJid ?? null;
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
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
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
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
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
      // Only registered groups — avoids filling disk with uninvited files.
      if (message.attachments.size > 0) {
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

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    // Slash command handlers (/model, /effort, /compact, /daily, /weekly, /monthly)
    this.client.on(
      Events.InteractionCreate,
      async (interaction: Interaction) => {
        if (!interaction.isChatInputCommand()) return;
        const cmd = interaction.commandName;
        if (cmd === 'model' || cmd === 'effort' || cmd === 'compact') {
          await this.handleRuntimeCommand(interaction);
          return;
        }
        if (cmd === 'daily' || cmd === 'weekly' || cmd === 'monthly') {
          await this.handleGrafanaSummaryCommand(interaction, cmd);
          return;
        }
      },
    );

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
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

  private async registerSlashCommands(): Promise<void> {
    if (!this.client?.application) return;
    const commands = [
      new SlashCommandBuilder()
        .setName('model')
        .setDescription('이 채널에서 사용할 Claude 모델 확인/변경')
        .addStringOption((opt) =>
          opt
            .setName('choice')
            .setDescription('사용할 모델 (생략 시 현재 설정 조회)')
            .setRequired(false)
            .addChoices(
              ...MODEL_CHOICES.map((c) => ({ name: c.label, value: c.value })),
              { name: '기본값 (SDK 기본 모델 사용)', value: DEFAULT_SENTINEL },
            ),
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName('effort')
        .setDescription('이 채널의 추론 깊이(effort) 확인/변경')
        .addStringOption((opt) =>
          opt
            .setName('level')
            .setDescription('추론 레벨 (생략 시 현재 설정 조회)')
            .setRequired(false)
            .addChoices(
              ...EFFORT_CHOICES.map((c) => ({ name: c.label, value: c.value })),
            ),
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName('compact')
        .setDescription(
          '이 채널의 대화 세션을 압축 (컨텍스트 로트 방지) — main/admin 전용',
        )
        .toJSON(),
      new SlashCommandBuilder()
        .setName('daily')
        .setDescription('일간 메트릭 요약 즉시 실행 (#grafana 전용)')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('weekly')
        .setDescription('주간 트렌드 요약 즉시 실행 (#grafana 전용)')
        .toJSON(),
      new SlashCommandBuilder()
        .setName('monthly')
        .setDescription('월간 SLI 리뷰 즉시 실행 (#grafana 전용)')
        .toJSON(),
    ];

    // Clear any lingering global registrations from previous versions —
    // otherwise they show up as duplicates alongside the guild-scoped ones.
    try {
      await this.client.application.commands.set([]);
      logger.info('Cleared global slash command registrations');
    } catch (err) {
      logger.warn({ err }, 'Failed to clear global slash commands');
    }

    // Register per-guild for instant visibility. Also covers guilds the bot
    // joins later via the guildCreate handler set up below.
    for (const [guildId, guild] of this.client.guilds.cache) {
      try {
        await guild.commands.set(commands);
        logger.info(
          { guildId, guildName: guild.name },
          'Slash commands registered for guild',
        );
      } catch (err) {
        logger.warn(
          { guildId, err },
          'Failed to register slash commands for guild',
        );
      }
    }

    // Re-register when the bot joins a new guild so /compact etc. work
    // immediately in new servers without waiting for global propagation.
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

  private async handleRuntimeCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
  ): Promise<void> {
    const chatJid = `dc:${interaction.channelId}`;
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      await interaction.reply({
        content: '이 채널은 NanoClaw에 등록되지 않았습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      if (interaction.commandName === 'model') {
        const choice = interaction.options.getString('choice');
        if (choice === null) {
          const cur = loadRuntimeSettings(group.folder);
          await interaction.reply({
            content: `현재 설정 — 모델: **${modelLabel(cur.model)}** · effort: **${effortLabel(cur.effort)}**`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const next = updateRuntimeSettings(group.folder, { model: choice });
        await interaction.reply({
          content: `모델 변경 완료 → **${modelLabel(next.model)}** (다음 메시지부터 적용)`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (interaction.commandName === 'effort') {
        const level = interaction.options.getString('level');
        if (level === null) {
          const cur = loadRuntimeSettings(group.folder);
          await interaction.reply({
            content: `현재 설정 — 모델: **${modelLabel(cur.model)}** · effort: **${effortLabel(cur.effort)}**`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const next = updateRuntimeSettings(group.folder, { effort: level });
        await interaction.reply({
          content: `Effort 변경 완료 → **${effortLabel(next.effort)}** (다음 메시지부터 적용)`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (interaction.commandName === 'compact') {
        // Trigger the host-side session-command interception by injecting a
        // synthetic "/compact" message as if the admin had typed it. The
        // orchestrator's handleSessionCommand picks it up and runs the SDK
        // /compact flow in a fresh container (transcript archived via the
        // PreCompact hook). Only the device owner can drive this path.
        const userId = interaction.user.id;
        const ownerId = process.env.DISCORD_OWNER_ID;
        const isOwner = ownerId ? userId === ownerId : false;
        if (!isOwner && !group.isMain) {
          await interaction.reply({
            content: 'Session commands require admin access.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: '세션 압축 시작 — 끝나면 채널에 결과 메시지 올라올게.',
          flags: MessageFlags.Ephemeral,
        });

        const now = new Date().toISOString();
        const synthetic: NewMessage = {
          id: `compact-${Date.now()}`,
          chat_jid: chatJid,
          sender: userId,
          sender_name: interaction.user.username,
          content: '/compact',
          timestamp: now,
          is_from_me: true,
        };
        // Channels deliver inbound messages via opts.onInboundMessage — same
        // path a real Discord message would take, so the orchestrator's
        // session-command interception (handleSessionCommand) triggers.
        this.opts.onChatMetadata(chatJid, now);
        this.opts.onMessage(chatJid, synthetic);
        return;
      }
    } catch (err) {
      logger.error(
        { err, commandName: interaction.commandName },
        'Slash command handler error',
      );
      if (!interaction.replied) {
        await interaction
          .reply({
            content: '명령 실행 실패. 서버 로그를 확인해주세요.',
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
  }

  private async handleGrafanaSummaryCommand(
    interaction: import('discord.js').ChatInputCommandInteraction,
    kind: 'daily' | 'weekly' | 'monthly',
  ): Promise<void> {
    const channelJid = `dc:${interaction.channelId}`;
    if (!this.grafanaJid || channelJid !== this.grafanaJid) {
      await interaction.reply({
        content: `\`/${kind}\` 명령은 #grafana 모니터링 채널에서만 사용할 수 있습니다.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const labels = { daily: '일간', weekly: '주간', monthly: '월간' };
    const label = labels[kind];

    const promptMap: Record<typeof kind, string> = {
      daily: `@${ASSISTANT_NAME} /daily — 지난 24시간 일간 메트릭 요약을 한국어 마크다운으로 작성해 채널에 게시. 포함: 총 요청량, 5xx 비율, p95/p99 latency, 다운타임 분, 발화한 알람 수/이름.`,
      weekly: `@${ASSISTANT_NAME} /weekly — 지난 7일 주간 트렌드 요약을 한국어 마크다운으로 작성해 채널에 게시. 일별 평균/최댓값, 전주 대비 ±%, 워스트 케이스 시점, 발화 알람 목록.`,
      monthly: `@${ASSISTANT_NAME} /monthly — 지난 30일 월간 SLI 리뷰를 한국어 마크다운으로 작성해 채널에 게시. 가용성(uptime%), 5xx 분포, p95/p99 latency 분포, 알람 타임라인, 주요 인시던트 회고.`,
    };

    await interaction.reply({
      content: `🔄 ${label} 요약 시작합니다. 잠시만 기다려주세요.`,
      flags: MessageFlags.Ephemeral,
    });

    const now = new Date().toISOString();
    const senderName =
      interaction.member?.user?.username ??
      interaction.user.displayName ??
      interaction.user.username;
    const msg: NewMessage = {
      id: `slash-${kind}-${Date.now()}`,
      chat_jid: channelJid,
      sender: interaction.user.id,
      sender_name: senderName,
      content: promptMap[kind],
      timestamp: now,
      is_from_me: true,
      is_bot_message: false,
    };
    this.opts.onMessage(channelJid, msg);

    logger.info(
      { kind, channelJid, sender: senderName, msgId: msg.id },
      'Grafana summary slash command dispatched',
    );
  }

  async sendStatus(jid: string, text: string): Promise<void> {
    if (!this.client) return;

    // Tool-use status already carries its own leading emoji (📖/⚡/🔍/…).
    // Italic keeps the "live progress" feel without duplicating the emoji.
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
          // Message was deleted or missing — fall through to a fresh send.
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
      const inboundFiles =
        files && files.length > 0
          ? files.map((f) => new AttachmentBuilder(f))
          : [];

      const {
        embeds,
        overflowText,
        attachments: tableAttachments,
      } = await buildEmbedsForMessage(text, metadata);

      // Image-embed `attachment://...` URLs must travel with the FIRST send().
      // Discord matches attachments by filename, so inbound files go with the
      // first payload too (existing behavior).
      const firstBatchFiles = [...inboundFiles, ...tableAttachments];

      // Empty text but attachments present — send files with no embed.
      if (embeds.length === 0) {
        if (firstBatchFiles.length > 0) {
          await textChannel.send({ files: firstBatchFiles });
        }
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
        await textChannel.send(payload);
      }

      if (overflowText) {
        const MAX_LENGTH = 2000;
        for (let i = 0; i < overflowText.length; i += MAX_LENGTH) {
          await textChannel.send(overflowText.slice(i, i + MAX_LENGTH));
        }
      }

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

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
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
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN', 'WEBHOOK_GRAFANA_JID']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  const grafanaJid =
    process.env.WEBHOOK_GRAFANA_JID || envVars.WEBHOOK_GRAFANA_JID || undefined;
  return new DiscordChannel(token, opts, grafanaJid);
});
