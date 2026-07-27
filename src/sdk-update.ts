/**
 * Agent-SDK self-update pipeline (host operation, driven by the /update slash
 * command). Bumps the container's @anthropic-ai/claude-agent-sdk to the latest
 * npm release, rebuilds the agent image to a candidate tag, verifies the image
 * actually initialises (supportedModels() responds), and only then promotes the
 * candidate to :latest and recycles running agent containers so the next turn
 * uses the new SDK. On any failure the live :latest is left untouched.
 *
 * The whole pipeline runs in the host process — it must NEVER restart the host
 * service itself (that would kill the in-flight command). Only agent CONTAINERS
 * are recycled; the runner reads :latest fresh at every spawn.
 */
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  ONECLI_API_KEY,
  ONECLI_URL,
} from './config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs } from './container-runtime.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
// The systemd unit runs with a minimal PATH that excludes the nvm bin dir, so
// resolve bun by its absolute path (bun/npm/node all live beside process.execPath).
const BUN = path.join(path.dirname(process.execPath), 'bun');
const AGENT_RUNNER_DIR = path.join(process.cwd(), 'container', 'agent-runner');
const BUILD_SCRIPT = path.join(process.cwd(), 'container', 'build.sh');
const CANDIDATE_TAG = 'update-candidate';
const ROLLBACK_TAG = 'update-rollback';
const BUILD_TIMEOUT_MS = 8 * 60 * 1000;
const FETCH_TIMEOUT_MS = 90 * 1000;

export interface SdkUpdateResult {
  readonly status: 'up-to-date' | 'updated' | 'failed';
  readonly from: string | null;
  readonly to: string | null;
  /** Model display names the new image reports, when the update succeeded. */
  readonly models?: readonly string[];
  readonly error?: string;
  /** How many running agent containers were recycled to adopt the new image. */
  readonly recycled?: number;
}

/** Latest published version of the agent SDK, from the npm registry (no npm bin). */
async function latestSdkVersion(): Promise<string> {
  const url = `https://registry.npmjs.org/${SDK_PKG.replace('/', '%2f')}/latest`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const body = (await res.json()) as { version?: string };
  if (!body.version) throw new Error('npm registry response missing version');
  return body.version;
}

/** SDK version currently baked into the given agent image. */
async function imageSdkVersion(image: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      [
        'run',
        '--rm',
        '--entrypoint',
        'node',
        image,
        '-e',
        `process.stdout.write(require('/app/node_modules/${SDK_PKG}/package.json').version)`,
      ],
      { timeout: 60_000 },
    );
    return stdout.trim() || null;
  } catch (err) {
    log.warn('sdk-update: could not read image SDK version', { image, err });
    return null;
  }
}

/**
 * Spawn a throwaway container from `image` and dump the SDK's supportedModels().
 * Returns null if the image fails to initialise — this is the health gate that
 * blocks promotion of a broken build. Credentials come from the OneCLI gateway.
 */
async function fetchSupportedModels(
  image: string,
): Promise<Array<{ value: string; displayName?: string; description?: string }> | null> {
  const fetchScript = `
import { query } from '/app/node_modules/${SDK_PKG}/sdk.mjs';
const q = query({ prompt: 'init', options: { permissionMode: 'bypassPermissions' } });
try { const m = await q.supportedModels(); console.log('MODELS_JSON=' + JSON.stringify(m)); }
catch (e) { console.error('supportedModels failed:', e && e.message ? e.message : e); }
process.exit(0);
`;
  const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
  const args = ['run', '-i', '--rm', '-w', '/app'];
  const applied = await onecli.applyContainerConfig(args, { addHostMapping: false });
  if (!applied) {
    log.warn('sdk-update: OneCLI gateway unavailable, cannot verify image');
    return null;
  }
  args.push(...hostGatewayArgs());
  args.push('--entrypoint', 'node', image, '--input-type=module', '-e', fetchScript);

  const out = await new Promise<string>((resolve) => {
    const proc = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve(o);
    }, FETCH_TIMEOUT_MS);
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
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(marker.length));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Kill running agent containers so the next spawn adopts the new :latest image. */
async function recycleAgentContainers(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '-q', '--filter', `ancestor=${CONTAINER_IMAGE}`],
      { timeout: 15_000 },
    );
    const ids = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return 0;
    await execFileAsync(CONTAINER_RUNTIME_BIN, ['kill', ...ids], { timeout: 30_000 });
    return ids.length;
  } catch (err) {
    log.warn('sdk-update: container recycle failed (new image still active for new spawns)', {
      err,
    });
    return 0;
  }
}

/**
 * Run the full update pipeline. Idempotent: a no-op when already on the latest
 * SDK. Never throws — failures are returned as { status: 'failed' }.
 */
export async function updateAgentSdk(): Promise<SdkUpdateResult> {
  let latest: string;
  try {
    latest = await latestSdkVersion();
  } catch (err) {
    return { status: 'failed', from: null, to: null, error: `npm view failed: ${String(err)}` };
  }
  const current = await imageSdkVersion(CONTAINER_IMAGE);
  if (current && current === latest) {
    return { status: 'up-to-date', from: current, to: latest };
  }

  const candidate = `${CONTAINER_IMAGE_BASE}:${CANDIDATE_TAG}`;
  try {
    // 1. Bump the lockfile to the latest SDK.
    await execFileAsync(BUN, ['update', SDK_PKG], {
      cwd: AGENT_RUNNER_DIR,
      timeout: 120_000,
    });

    // 2. Build a candidate image (does NOT touch the live :latest).
    await execFileAsync('bash', [BUILD_SCRIPT, CANDIDATE_TAG], { timeout: BUILD_TIMEOUT_MS });

    // 3. Health gate: the candidate must initialise and report models.
    const models = await fetchSupportedModels(candidate);
    if (!models || models.length === 0) {
      return {
        status: 'failed',
        from: current,
        to: latest,
        error: 'candidate image failed health check (supportedModels() returned nothing)',
      };
    }

    // 4. Promote: keep a rollback tag, then point :latest at the candidate.
    await execFileAsync(CONTAINER_RUNTIME_BIN, [
      'tag',
      CONTAINER_IMAGE,
      `${CONTAINER_IMAGE_BASE}:${ROLLBACK_TAG}`,
    ]).catch(() => undefined);
    await execFileAsync(CONTAINER_RUNTIME_BIN, ['tag', candidate, CONTAINER_IMAGE]);

    // 5. Recycle running containers so the new SDK takes effect promptly.
    const recycled = await recycleAgentContainers();

    const names = models.map((m) => m.description || m.displayName || m.value);
    log.info('sdk-update: updated', { from: current, to: latest, recycled });
    return { status: 'updated', from: current, to: latest, models: names, recycled };
  } catch (err) {
    log.error('sdk-update: pipeline failed', { err });
    return { status: 'failed', from: current, to: latest, error: String(err) };
  }
}
