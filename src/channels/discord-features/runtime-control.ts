import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import {
  DEFAULT_SENTINEL,
  EFFORT_CHOICES,
  MODEL_CHOICES,
  effortLabel,
  loadRuntimeSettings,
  modelLabel,
  updateRuntimeSettings,
} from '../../group-runtime-settings.js';
import { logger } from '../../logger.js';
import type { NewMessage } from '../../types.js';

import type {
  DiscordFeature,
  DiscordFeatureContext,
  SlashCommandJSON,
} from './feature.js';

const COMMANDS: readonly string[] = ['model', 'effort', 'compact'];

function buildCommands(): SlashCommandJSON[] {
  return [
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
  ];
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  ctx: DiscordFeatureContext,
): Promise<boolean> {
  if (!COMMANDS.includes(interaction.commandName)) return false;

  const chatJid = `dc:${interaction.channelId}`;
  const group = ctx.registeredGroups()[chatJid];
  if (!group) {
    await interaction.reply({
      content: '이 채널은 NanoClaw에 등록되지 않았습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
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
        return true;
      }
      const next = updateRuntimeSettings(group.folder, { model: choice });
      await interaction.reply({
        content: `모델 변경 완료 → **${modelLabel(next.model)}** (다음 메시지부터 적용)`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (interaction.commandName === 'effort') {
      const level = interaction.options.getString('level');
      if (level === null) {
        const cur = loadRuntimeSettings(group.folder);
        await interaction.reply({
          content: `현재 설정 — 모델: **${modelLabel(cur.model)}** · effort: **${effortLabel(cur.effort)}**`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      const next = updateRuntimeSettings(group.folder, { effort: level });
      await interaction.reply({
        content: `Effort 변경 완료 → **${effortLabel(next.effort)}** (다음 메시지부터 적용)`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (interaction.commandName === 'compact') {
      const userId = interaction.user.id;
      const ownerId = process.env.DISCORD_OWNER_ID;
      const isOwner = ownerId ? userId === ownerId : false;
      if (!isOwner && !group.isMain) {
        await interaction.reply({
          content: 'Session commands require admin access.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
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
      ctx.onChatMetadata(chatJid, now);
      ctx.onMessage(chatJid, synthetic);
      return true;
    }
  } catch (err) {
    logger.error(
      { err, commandName: interaction.commandName },
      'runtime-control command handler error',
    );
    if (!interaction.replied) {
      await interaction
        .reply({
          content: '명령 실행 실패. 서버 로그를 확인해주세요.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    return true;
  }

  return false;
}

export const runtimeControlFeature: DiscordFeature = {
  name: 'runtime-control',
  slashCommands: buildCommands,
  handleCommand,
};
