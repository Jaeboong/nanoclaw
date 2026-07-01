/**
 * Dynamic model catalog. The /model choices are NOT hardcoded version IDs —
 * they come from the container Agent SDK's `query().supportedModels()`, which
 * only runs inside a container (where OneCLI injects working credentials).
 *
 * Flow: a short-lived container dumps supportedModels() as JSON, cached to
 * `data/models-catalog.json`; the /model slash builds its choices + labels
 * from that cache. New releases surface as soon as a refresh repopulates the
 * cache (on boot, and after /update bumps the SDK). v2's chat-SDK Discord
 * adapter drops autocomplete, so choices are registered at boot from the cache
 * rather than resolved live per-keystroke — a host restart re-reads the cache.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { OneCLI } from '@onecli-sh/sdk';

import { CONTAINER_IMAGE, DATA_DIR, ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from './container-runtime.js';
import { log } from './log.js';

/** Sentinel choice value meaning "clear the override → use the SDK default". */
export const DEFAULT_MODEL_VALUE = '__default__';

export interface ModelCatalogEntry {
  /** Alias sent to the SDK (e.g. 'sonnet', 'opus'); 'default' = SDK default. */
  readonly value: string;
  /** Concrete model the alias resolves to (e.g. 'claude-sonnet-5'), if reported. */
  readonly resolvedModel?: string;
  readonly displayName: string;
  readonly description: string;
}

/** Discord choice `name` fields are capped at 100 characters. */
const CHOICE_NAME_LIMIT = 100;
const CACHE_PATH = path.join(DATA_DIR, 'models-catalog.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 90_000;

/** Fallback before any refresh has populated the cache (aliases, no versions). */
export const SEED_CATALOG: readonly ModelCatalogEntry[] = [
  { value: 'default', displayName: 'Default', description: '기본 (권장)' },
  { value: 'opus', displayName: 'Opus', description: '최고 품질' },
  { value: 'haiku', displayName: 'Haiku', description: '가장 빠름' },
];

/** Validate/normalize a raw supportedModels() payload. */
export function parseCatalog(raw: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelCatalogEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.value !== 'string' || r.value.length === 0) continue;
    out.push({
      value: r.value,
      resolvedModel: typeof r.resolvedModel === 'string' ? r.resolvedModel : undefined,
      displayName:
        typeof r.displayName === 'string' && r.displayName.length > 0 ? r.displayName : r.value,
      description: typeof r.description === 'string' ? r.description : '',
    });
  }
  return out;
}

/** Read the cached catalog, falling back to the seed when absent/invalid. */
export function loadCatalog(): ModelCatalogEntry[] {
  try {
    if (!fs.existsSync(CACHE_PATH)) return [...SEED_CATALOG];
    const parsed = parseCatalog(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')));
    return parsed.length > 0 ? parsed : [...SEED_CATALOG];
  } catch (err) {
    log.warn('model-catalog: cache read failed, using seed', { err });
    return [...SEED_CATALOG];
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Label shown for a catalog entry (concrete version comes from `description`). */
export function modelChoiceLabel(e: ModelCatalogEntry): string {
  const label = e.description ? `${e.displayName} — ${e.description}` : e.displayName;
  return truncate(label, CHOICE_NAME_LIMIT);
}

/** Build the /model slash choices from the live catalog. */
export function catalogChoices(
  entries: readonly ModelCatalogEntry[] = loadCatalog(),
): { readonly name: string; readonly value: string }[] {
  const choices = [{ name: 'Default — 기본 (권장)', value: DEFAULT_MODEL_VALUE }];
  for (const e of entries) {
    if (e.value === 'default') continue; // represented by the sentinel above
    choices.push({ name: modelChoiceLabel(e), value: e.value });
  }
  return choices;
}

/** Human label for a stored model value (null/sentinel = SDK default). */
export function labelForModel(
  value: string | null,
  entries: readonly ModelCatalogEntry[] = loadCatalog(),
): string {
  if (!value || value === DEFAULT_MODEL_VALUE) {
    const def = entries.find((e) => e.value === 'default');
    return def ? `기본 · ${def.description || def.displayName}` : '기본 (SDK 기본 모델)';
  }
  const e = entries.find((x) => x.value === value);
  return e ? modelChoiceLabel(e) : value;
}

function cacheIsFresh(): boolean {
  try {
    return Date.now() - fs.statSync(CACHE_PATH).mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

// Script run inside the agent container to dump the SDK's model list. Creds are
// injected by the OneCLI gateway via the proxy env applied to the container args.
const FETCH_SCRIPT = `
import { query } from '/app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const q = query({ prompt: 'init', options: { permissionMode: 'bypassPermissions' } });
try { const m = await q.supportedModels(); console.log('MODELS_JSON=' + JSON.stringify(m)); }
catch (e) { console.error('supportedModels failed:', e && e.message ? e.message : e); }
process.exit(0);
`;

/**
 * Spawn a short-lived container to fetch the live model list and write the
 * cache atomically. Best-effort: returns false on any failure, leaving any
 * existing cache intact. `force` bypasses the freshness check.
 */
export async function refreshModelCatalog(force = false): Promise<boolean> {
  if (!force && cacheIsFresh()) return false;
  try {
    const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
    const args = ['run', '-i', '--rm', '-w', '/app'];
    const applied = await onecli.applyContainerConfig(args, { addHostMapping: false });
    if (!applied) {
      log.warn('model-catalog: OneCLI gateway unavailable, skipping refresh');
      return false;
    }
    args.push(...hostGatewayArgs());
    args.push('--entrypoint', 'node', CONTAINER_IMAGE, '--input-type=module', '-e', FETCH_SCRIPT);

    const out = await new Promise<string>((resolve) => {
      const proc = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(o);
      }, REFRESH_TIMEOUT_MS);
      proc.stdout.on('data', (d: Buffer) => (o += d.toString()));
      proc.on('close', () => {
        clearTimeout(timer);
        resolve(o);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(o);
      });
    });

    const marker = 'MODELS_JSON=';
    const line = out.split('\n').find((l) => l.startsWith(marker));
    if (!line) {
      log.warn('model-catalog: no models output from container');
      return false;
    }
    const entries = parseCatalog(JSON.parse(line.slice(marker.length)));
    if (entries.length === 0) return false;
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
    fs.renameSync(tmp, CACHE_PATH);
    log.info('model-catalog: refreshed', {
      count: entries.length,
      models: entries.map((e) => e.value),
    });
    return true;
  } catch (err) {
    log.warn('model-catalog: refresh failed', { err });
    return false;
  }
}
