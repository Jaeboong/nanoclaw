/**
 * Tone resolver. Public source uses neutral Korean; an optional override
 * file at `src/tone/<NANOCLAW_TONE>.ts` (gitignored) can replace the
 * message map and emoji at startup.
 *
 * Override modules export:
 *   - `MESSAGES: Partial<Record<MessageKey, string>>`
 *   - `EMOJI: string`
 *
 * Missing/partial overrides fall back to neutral.
 */
import {
  NEUTRAL_MESSAGES,
  NEUTRAL_EMOJI,
  type MessageKey,
} from './messages.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

let activeMessages: Record<MessageKey, string> = NEUTRAL_MESSAGES;
let activeEmoji: string = NEUTRAL_EMOJI;

const envConfig = readEnvFile(['NANOCLAW_TONE']);
const tone = (
  process.env.NANOCLAW_TONE ||
  envConfig.NANOCLAW_TONE ||
  ''
).trim();
if (tone && /^[a-z][a-z0-9_-]*$/.test(tone)) {
  // Variable-path import so tsc doesn't statically resolve the module
  // (override files are optional and may not exist in a fresh checkout).
  const dyn = (p: string): Promise<unknown> => import(p);
  try {
    const mod = (await dyn(`./${tone}.js`)) as {
      MESSAGES?: Partial<Record<MessageKey, string>>;
      EMOJI?: string;
    };
    if (mod.MESSAGES) {
      activeMessages = { ...NEUTRAL_MESSAGES, ...mod.MESSAGES };
    }
    if (typeof mod.EMOJI === 'string') {
      activeEmoji = mod.EMOJI;
    }
    logger.info({ tone }, 'tone override loaded');
  } catch (err) {
    logger.warn(
      { tone, err: err instanceof Error ? err.message : String(err) },
      'tone override not found — using neutral',
    );
  }
}

export function getMessage(
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let s = activeMessages[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split('{' + k + '}').join(String(v));
    }
  }
  return s;
}

export function getEmoji(): string {
  return activeEmoji;
}

export type { MessageKey };
