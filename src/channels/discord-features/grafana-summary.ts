import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { ASSISTANT_NAME } from '../../config.js';
import { logger } from '../../logger.js';
import type { NewMessage } from '../../types.js';

import type {
  DiscordFeature,
  DiscordFeatureContext,
  SlashCommandJSON,
} from './feature.js';

const KINDS = ['daily', 'weekly', 'monthly'] as const;
type Kind = (typeof KINDS)[number];

export interface GrafanaSummaryFeatureConfig {
  /** Channel JID (`dc:<id>`) of the monitoring channel where these commands are allowed. */
  grafanaJid: string;
}

export function createGrafanaSummaryFeature(
  config: GrafanaSummaryFeatureConfig,
): DiscordFeature {
  const { grafanaJid } = config;

  const slashCommands = (): SlashCommandJSON[] => [
    new SlashCommandBuilder()
      .setName('daily')
      .setDescription('일간 메트릭 요약 즉시 실행 (모니터링 채널 전용)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('weekly')
      .setDescription('주간 트렌드 요약 즉시 실행 (모니터링 채널 전용)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('monthly')
      .setDescription('월간 SLI 리뷰 즉시 실행 (모니터링 채널 전용)')
      .toJSON(),
  ];

  const handleCommand = async (
    interaction: ChatInputCommandInteraction,
    ctx: DiscordFeatureContext,
  ): Promise<boolean> => {
    const kind = interaction.commandName as Kind;
    if (!KINDS.includes(kind)) return false;

    const channelJid = `dc:${interaction.channelId}`;
    if (channelJid !== grafanaJid) {
      await interaction.reply({
        content: `\`/${kind}\` 명령은 모니터링 채널에서만 사용할 수 있습니다.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const labels: Record<Kind, string> = {
      daily: '일간',
      weekly: '주간',
      monthly: '월간',
    };
    const label = labels[kind];

    const promptMap: Record<Kind, string> = {
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
    ctx.onMessage(channelJid, msg);

    logger.info(
      { kind, channelJid, sender: senderName, msgId: msg.id },
      'Grafana summary slash command dispatched',
    );
    return true;
  };

  return {
    name: 'grafana-summary',
    slashCommands,
    handleCommand,
  };
}
