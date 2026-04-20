/**
 * Per-group runtime settings: which model/effort to use for the next agent
 * spawn. Set via /model and /effort Discord slash commands, persisted to
 * groups/<folder>/runtime-settings.json, read by the host before spawning
 * a container.
 */
import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

const FILE_NAME = 'runtime-settings.json';

export const MODEL_CHOICES = [
  { label: 'Opus 4.7 (최고 품질)', value: 'claude-opus-4-7' },
  { label: 'Sonnet 4.6 (균형형)', value: 'claude-sonnet-4-6' },
  {
    label: 'Haiku 4.5 (가장 빠르고 저렴)',
    value: 'claude-haiku-4-5-20251001',
  },
] as const;
export const ALLOWED_MODELS = new Set<string>(MODEL_CHOICES.map((c) => c.value));

export const EFFORT_CHOICES = [
  { label: 'Off — 추론 기능 꺼짐', value: 'off' },
  { label: 'Low — 최소한의 추론, 가장 빠름', value: 'low' },
  { label: 'Medium — 적당한 추론', value: 'medium' },
  { label: 'High — 깊은 추론 (기본값)', value: 'high' },
  { label: 'Max — 최대 노력 (Opus 전용)', value: 'max' },
] as const;
export const ALLOWED_EFFORTS = new Set<string>(
  EFFORT_CHOICES.map((c) => c.value),
);

/** Sentinel for "clear this setting" in updateRuntimeSettings patches. */
export const DEFAULT_SENTINEL = '__default__';

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export interface GroupRuntimeSettings {
  /** Undefined = use SDK default model. */
  model?: string;
  /**
   * Extended-thinking effort. Undefined = SDK default. 'off' is represented
   * by storing `effort: undefined` (i.e., not setting it); do NOT persist
   * the string 'off'.
   */
  effort?: EffortLevel;
}

function settingsPath(folder: string): string {
  return path.join(resolveGroupFolderPath(folder), FILE_NAME);
}

export function loadRuntimeSettings(folder: string): GroupRuntimeSettings {
  const p = settingsPath(folder);
  if (!fs.existsSync(p)) return {};
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: GroupRuntimeSettings = {};
    if (typeof parsed.model === 'string' && ALLOWED_MODELS.has(parsed.model)) {
      out.model = parsed.model;
    }
    if (
      typeof parsed.effort === 'string' &&
      ['low', 'medium', 'high', 'max'].includes(parsed.effort)
    ) {
      out.effort = parsed.effort as EffortLevel;
    }
    return out;
  } catch (err) {
    logger.warn({ folder, err }, 'runtime-settings: failed to read, using defaults');
    return {};
  }
}

export function saveRuntimeSettings(
  folder: string,
  settings: GroupRuntimeSettings,
): void {
  const p = settingsPath(folder);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Patch semantics:
 * - model === DEFAULT_SENTINEL → clear model override
 * - effort === 'off' → clear effort override (disables extended thinking)
 * - unknown/invalid values → ignored (keep current)
 */
export function updateRuntimeSettings(
  folder: string,
  patch: { model?: string; effort?: string },
): GroupRuntimeSettings {
  const current = loadRuntimeSettings(folder);
  const next: GroupRuntimeSettings = { ...current };

  if ('model' in patch) {
    if (patch.model === undefined || patch.model === DEFAULT_SENTINEL) {
      delete next.model;
    } else if (ALLOWED_MODELS.has(patch.model)) {
      next.model = patch.model;
    }
  }
  if ('effort' in patch) {
    if (patch.effort === undefined || patch.effort === 'off') {
      delete next.effort;
    } else if (['low', 'medium', 'high', 'max'].includes(patch.effort)) {
      next.effort = patch.effort as EffortLevel;
    }
  }

  saveRuntimeSettings(folder, next);
  return next;
}

/** Human-readable label for a model ID, or the raw ID if unknown. */
export function modelLabel(value: string | undefined): string {
  if (!value) return '기본값 (SDK 기본 모델)';
  const choice = MODEL_CHOICES.find((c) => c.value === value);
  return choice ? choice.label : value;
}

export function effortLabel(value: string | undefined): string {
  if (!value) return 'off';
  return value;
}
