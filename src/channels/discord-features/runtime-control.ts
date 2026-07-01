/**
 * `/model` and `/effort` slash commands — per-channel agent model & reasoning
 * effort, persisted to `container_configs` and applied at the next container
 * spawn.
 *
 * Additive module (see docs/UPSTREAM-MERGE.md): self-registers into the
 * interaction framework on import; touches no upstream-core logic. State lives
 * in the `container_configs` row (v2's idiom; v1 used a per-folder
 * `runtime-settings.json`). A change applies immediately: after persisting, any
 * running container for the group is restarted (via the existing
 * `restartAgentGroupContainers` primitive) so the new model/effort takes effect
 * without waiting for a natural spawn — restoring v1's "applies right away" feel.
 *
 * Auth: admin-gated (`requireAdmin`) — a config change, conforming to v2's
 * command-gate model. v1 left these open to any group member; the owner is
 * unaffected (the owner role authorizes everywhere). This is a deliberate
 * conform-to-upstream tightening.
 *
 * Choices are a fixed list: the adapter drops Autocomplete interactions over
 * the gateway, so v1's dynamic model autocomplete isn't available.
 */
import { restartAgentGroupContainers } from '../../container-restart.js';
import { updateAgentSdk } from '../../sdk-update.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import {
  OPTION_STRING,
  registerSlashCommand,
  type SlashInvocation,
  type SlashResult,
} from '../discord-interactions.js';

/** Sentinel choice value meaning "clear the override; use the SDK default". */
const DEFAULT_VALUE = '__default__';

interface Choice {
  readonly name: string;
  readonly value: string;
}

// Values are model ALIASES resolved server-side by the Agent SDK, NOT pinned
// version IDs — so a choice tracks the current release with no hardcode bump.
// The valid aliases are exactly what the container SDK's supportedModels()
// returns; as of agent-runner @anthropic-ai/claude-agent-sdk 0.3.170 that is
// { default (Sonnet family), opus, haiku } — there is no standalone 'sonnet'
// alias and no Sonnet 5 until the container SDK is upgraded. Keep this list in
// sync with supportedModels(); the dynamic catalog (see model-catalog, v1) is
// the proper fix so the menu + labels reflect live SDK support automatically.
const MODEL_CHOICES: readonly Choice[] = [
  { name: 'Default — 권장 (기본 · 현재 Sonnet 계열)', value: DEFAULT_VALUE },
  { name: 'Opus — 최고 품질', value: 'opus' },
  { name: 'Haiku — 가장 빠름·저렴', value: 'haiku' },
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

/**
 * Apply a model/effort change to any running container immediately. A container
 * caches its config at spawn, so kill it (no wake message) and let the next
 * message respawn with the new config — restoring v1's "applies right away"
 * feel instead of waiting for a far-off natural restart. No-op (and the change
 * applies on next spawn) when nothing is running. Returns a user-facing suffix.
 */
function applyLive(agentGroupId: string, reason: string): string {
  const restarted = restartAgentGroupContainers(agentGroupId, reason);
  return restarted > 0 ? `(실행 중 컨테이너 ${restarted}개 재시작 — 즉시 적용)` : '(다음 컨테이너 시작부터 적용)';
}

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
  const suffix = applyLive(group.agentGroupId, 'Model changed via /model');
  return { text: `모델 변경 → **${labelForModel(model)}** ${suffix}` };
}

async function handleEffort(inv: SlashInvocation): Promise<SlashResult> {
  const group = resolveAgentGroup(inv.platformId);
  if (!group) return { text: NOT_WIRED };

  const level = inv.options.level;
  if (level === undefined) return { text: currentSettings(group.agentGroupId) };

  ensureContainerConfig(group.agentGroupId);
  const effort = level === 'off' ? null : level;
  updateContainerConfigScalars(group.agentGroupId, { effort });
  const suffix = applyLive(group.agentGroupId, 'Effort changed via /effort');
  return { text: `Effort 변경 → **${labelForEffort(effort)}** ${suffix}` };
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

async function handleUpdate(_inv: SlashInvocation): Promise<SlashResult> {
  const r = await updateAgentSdk();
  if (r.status === 'up-to-date') {
    return { text: `이미 최신입니다 — Agent SDK **${r.to}**.` };
  }
  if (r.status === 'failed') {
    return {
      text: `업데이트 실패 (${r.from ?? '?'} → ${r.to ?? '?'}): ${r.error ?? '알 수 없는 오류'}.\n라이브 이미지는 그대로 유지됩니다.`,
    };
  }
  const models = r.models?.length ? `\n모델: ${r.models.join(', ')}` : '';
  return {
    text: `Agent SDK 업데이트 완료 — **${r.from ?? '?'} → ${r.to}**. 컨테이너 ${r.recycled ?? 0}개 재활용.${models}`,
  };
}

registerSlashCommand(
  {
    name: 'update',
    description: 'Agent SDK를 최신 버전으로 업데이트 (컨테이너 재빌드 후 교체)',
    requireAdmin: true,
    deferred: true,
  },
  handleUpdate,
);

export { handleModel, handleEffort, handleUpdate, MODEL_CHOICES, EFFORT_CHOICES, DEFAULT_VALUE };
