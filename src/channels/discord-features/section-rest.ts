/**
 * Minimal Discord REST poster for native colored embeds (additive module).
 *
 * The cross-platform chat-adapter can only emit a single hard-coded-color embed
 * via the card path, so faithful multi-color section boxes
 * ({@link ./section-embeds}) are posted straight to the Discord REST API here,
 * bypassing the adapter. Uses the same `DISCORD_BOT_TOKEN` the adapter does.
 *
 * Degrades safely: returns null on missing token, HTTP error, or rate limit so
 * the bridge falls back to the plain-markdown delivery path. Never throws into
 * delivery.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import type { DiscordEmbed, EmbedAttachment } from './section-embeds.js';

const DISCORD_API = 'https://discord.com/api/v10';
const EMBEDS_PER_MESSAGE = 10;

export interface RichPayload {
  embeds: readonly DiscordEmbed[];
  /** PNG attachments referenced by embeds via `attachment://<name>`. */
  attachments: readonly EmbedAttachment[];
  /** Agent-sent files (not embed-referenced); ride on the first message. */
  extraFiles?: readonly EmbedAttachment[];
  /** Plain content posted above the embeds (e.g. overflow text). Optional. */
  content?: string;
}

export interface PostDeps {
  /** Injectable fetch + token for tests. */
  fetchFn?: typeof fetch;
  token?: string | null;
}

function resolveToken(deps: PostDeps): string | null {
  if (deps.token !== undefined) return deps.token;
  return readEnvFile(['DISCORD_BOT_TOKEN']).DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN ?? null;
}

/**
 * Post colored embeds to a Discord channel/thread. Splits into multiple
 * messages when over the 10-embed limit, keeping each embed's referenced PNG
 * attachment in the same message. Returns the first message id, or null if the
 * caller should fall back to plain markdown.
 */
export async function postSectionEmbeds(
  channelId: string,
  payload: RichPayload,
  deps: PostDeps = {},
): Promise<string | null> {
  const token = resolveToken(deps);
  if (!token) {
    log.warn('section-rest: no DISCORD_BOT_TOKEN; falling back to markdown');
    return null;
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const attachmentByName = new Map(payload.attachments.map((a) => [a.name, a]));

  // Chunk embeds into <=10 per message; the first chunk also carries the
  // optional plain `content`.
  const chunks: DiscordEmbed[][] = [];
  for (let i = 0; i < payload.embeds.length; i += EMBEDS_PER_MESSAGE) {
    chunks.push(payload.embeds.slice(i, i + EMBEDS_PER_MESSAGE));
  }
  if (chunks.length === 0) return null;

  let firstId: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const embeds = chunks[i];
    // Collect the attachments this chunk's embeds reference.
    const files: EmbedAttachment[] = [];
    for (const e of embeds) {
      const ref = e.image?.url?.startsWith('attachment://') ? e.image.url.slice('attachment://'.length) : null;
      const att = ref ? attachmentByName.get(ref) : undefined;
      if (att) files.push(att);
    }
    // Agent-sent files ride on the first message, unreferenced by any embed.
    if (i === 0 && payload.extraFiles) files.push(...payload.extraFiles);
    const body = {
      content: i === 0 && payload.content ? payload.content.slice(0, 2000) : undefined,
      embeds,
      attachments: files.map((f, idx) => ({ id: idx, filename: f.name })),
    };

    try {
      const id = await postOne(fetchFn, token, channelId, body, files);
      if (id === null) return firstId; // HTTP failure mid-stream — stop, keep what landed.
      if (i === 0) firstId = id;
    } catch (err) {
      log.error('section-rest: post failed', { err: String(err), channelId });
      return firstId;
    }
  }
  return firstId;
}

async function postOne(
  fetchFn: typeof fetch,
  token: string,
  channelId: string,
  body: Record<string, unknown>,
  files: readonly EmbedAttachment[],
): Promise<string | null> {
  const url = `${DISCORD_API}/channels/${channelId}/messages`;
  const headers: Record<string, string> = { Authorization: `Bot ${token}` };

  let init: RequestInit;
  if (files.length > 0) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(body));
    files.forEach((f, idx) => {
      form.append(`files[${idx}]`, new Blob([f.data]), f.name);
    });
    init = { method: 'POST', headers, body: form };
  } else {
    init = {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  const res = await fetchFn(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    log.warn('section-rest: discord API rejected message', {
      status: res.status,
      channelId,
      detail: detail.slice(0, 300),
    });
    return null;
  }
  const json = (await res.json()) as { id?: string };
  return json.id ?? null;
}
