/**
 * `/model` and `/effort` slash commands — per-channel agent model & reasoning
 * effort, persisted to `container_configs` and applied at the next container
 * spawn.
 *
 * Additive module (see docs/UPSTREAM-MERGE.md): self-registers into the
 * interaction framework on import; touches no upstream-core logic. v1 stored
 * these in a per-folder `runtime-settings.json` applied on the *next message*;
 * v2's idiom is the `container_configs` row applied at *spawn* — an
 * adopt-upstream behavior delta (a change takes effect when the container next
 * starts, not mid-session).
 *
 * Auth: admin-gated (`requireAdmin`) — a config change, conforming to v2's
 * command-gate model. v1 left these open to any group member; the owner is
 * unaffected (the owner role authorizes everywhere). This is a deliberate
 * conform-to-upstream tightening.
 *
 * Choices are a fixed list: the adapter drops Autocomplete interactions over
 * the gateway, so v1's dynamic model autocomplete isn't available.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  ensureContainerConfig,
  getContainerConfig,
  updateContainerConfigScalars,
} from '../../db/container-configs.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { OPTION_STRING, registerSlashCommand, type SlashInvocation, type SlashResult } from '../discord-interactions.js';

/** Sentinel choice value meaning "clear the override; use the SDK default". */
const DEFAULT_VALUE = '__default__';

interface Choice {
  readonly name: string;
  readonly value: string;
}

const MODEL_CHOICES: readonly Choice[] = [
  { name: 'Opus 4.8 — 최고 품질', value: 'claude-opus-4-8' },
  { name: 'Opus 4.7', value: 'claude-opus-4-7' },
  { name: 'Sonnet 4.6 — 균형', value: 'claude-sonnet-4-6' },
  { name: 'Haiku 4.5 — 빠르고 저렴', value: 'claude-haiku-4-5-20251001' },
  { name: 'Default — SDK 기본 모델', value: DEFAULT_VALUE },
];

const EFFORT_CHOICES: readonly Choice[] = [
  { name: 'off — 추론 끔', value: 'off' },
  { name: 'low — 최소 추론', value: 'low' },
  { name: 'medium — 적당한 추론', value: 'medium' },
  { name: 'high — 깊은 추론 (기본)', value: 'high' },
  { name: 'xhigh — 더 깊음', value: 'xhigh' },
  { name: 'max — 최대', value: 'max' },
];

const MODEL_LABEL = new Map(MODEL_CHOICES.map((c) => [c.value, c.name]));

function labelForModel(model: string | null): string {
  if (!model) return 'Default (SDK 기본 모델)';
  return MODEL_LABEL.get(model) ?? model;
}

function labelForEffort(effort: string | null): string {
  return effort ?? 'off';
}

interface ResolvedGroup {
  readonly agentGroupId: string;
  readonly name: string;
}

/**
 * Resolve the agent group a Discord channel is wired to. A channel can wire
 * multiple agents; the slash command targets the first (priority-ordered) —
 * the common case is 1:1.
 */
function resolveAgentGroup(platformId: string): ResolvedGroup | null {
  const mg = getMessagingGroupByPlatform('discord', platformId);
  if (!mg) return null;
  const agentGroupId = getMessagingGroupAgents(mg.id)[0]?.agent_group_id;
  if (!agentGroupId) return null;
  const ag = getAgentGroup(agentGroupId);
  return { agentGroupId, name: ag?.name ?? ag?.folder ?? agentGroupId };
}

const NOT_WIRED = '이 채널은 NanoClaw 에이전트에 연결되어 있지 않습니다.';

function currentSettings(agentGroupId: string): string {
  const cfg = getContainerConfig(agentGroupId);
  return `현재 — 모델: **${labelForModel(cfg?.model ?? null)}** · effort: **${labelForEffort(cfg?.effort ?? null)}**`;
}

async function handleModel(inv: SlashInvocation): Promise<SlashResult> {
  const group = resolveAgentGroup(inv.platformId);
  if (!group) return { text: NOT_WIRED };

  const choice = inv.options.choice;
  if (choice === undefined) return { text: currentSettings(group.agentGroupId) };

  ensureContainerConfig(group.agentGroupId);
  const model = choice === DEFAULT_VALUE ? null : choice;
  updateContainerConfigScalars(group.agentGroupId, { model });
  return { text: `모델 변경 → **${labelForModel(model)}** (다음 컨테이너 시작부터 적용)` };
}

async function handleEffort(inv: SlashInvocation): Promise<SlashResult> {
  const group = resolveAgentGroup(inv.platformId);
  if (!group) return { text: NOT_WIRED };

  const level = inv.options.level;
  if (level === undefined) return { text: currentSettings(group.agentGroupId) };

  ensureContainerConfig(group.agentGroupId);
  const effort = level === 'off' ? null : level;
  updateContainerConfigScalars(group.agentGroupId, { effort });
  return { text: `Effort 변경 → **${labelForEffort(effort)}** (다음 컨테이너 시작부터 적용)` };
}

registerSlashCommand(
  {
    name: 'model',
    description: '이 채널 에이전트의 Claude 모델 확인/변경',
    requireAdmin: true,
    options: [
      {
        type: OPTION_STRING,
        name: 'choice',
        description: '사용할 모델 (생략 시 현재 설정 조회)',
        required: false,
        choices: MODEL_CHOICES,
      },
    ],
  },
  handleModel,
);

registerSlashCommand(
  {
    name: 'effort',
    description: '이 채널 에이전트의 추론 깊이(effort) 확인/변경',
    requireAdmin: true,
    options: [
      {
        type: OPTION_STRING,
        name: 'level',
        description: '추론 레벨 (생략 시 현재 설정 조회)',
        required: false,
        choices: EFFORT_CHOICES,
      },
    ],
  },
  handleEffort,
);

export { handleModel, handleEffort, MODEL_CHOICES, EFFORT_CHOICES, DEFAULT_VALUE };
