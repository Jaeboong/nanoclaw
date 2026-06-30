/**
 * Discord rich-delivery hook: agent reply → colored section embeds (additive).
 *
 * Wires {@link ./section-embeds} + {@link ./section-rest} into the bridge's
 * generic `deliverRichMessage` seam. Every non-blank Discord reply becomes one
 * or more colored embed boxes (the v1 "흰/초록/파랑/빨강/노랑/회색 칸" look),
 * posted straight to the Discord REST API since the cross-platform card path
 * can only emit a single hard-coded-color embed.
 *
 * Returns { handled: false } on blank input, a non-Discord thread id, or any
 * delivery failure, so the bridge cleanly falls back to plain markdown (which
 * still gets PNG tables via {@link ./table-outbound}).
 *
 * Additive: no upstream-core logic — see docs/UPSTREAM-MERGE.md. Wired by
 * `discord.ts` via `createChatSdkBridge({ deliverRichMessage })`.
 */
import { log } from '../../log.js';
import { buildSectionEmbeds, type EmbedAttachment, type SectionMetadata } from './section-embeds.js';
import { postSectionEmbeds, type PostDeps } from './section-rest.js';

/** Outbound file as the bridge hands it to the hook. */
export interface RichOutboundFile {
  data: Buffer;
  filename: string;
}

export interface RichDeliverInput {
  /** Adapter-encoded thread id, e.g. `discord:<guildId>:<channelId>`. */
  threadId: string;
  text: string;
  files: readonly RichOutboundFile[];
  metadata?: SectionMetadata;
}

export type RichDeliverResult = { handled: true; messageId?: string } | { handled: false };

/**
 * Extract the raw Discord channel/thread snowflake from an adapter-encoded
 * thread id (`discord:<guildId>:<channelId>` or `discord:@me:<id>`). Returns
 * null when the id is not a Discord thread.
 */
export function discordChannelId(threadId: string): string | null {
  if (!threadId.startsWith('discord:')) return null;
  const id = threadId.slice(threadId.lastIndexOf(':') + 1);
  return /^\d+$/.test(id) ? id : null;
}

export interface SectionDeliverDeps extends PostDeps {
  build?: typeof buildSectionEmbeds;
  post?: typeof postSectionEmbeds;
}

export async function deliverSectionEmbeds(
  input: RichDeliverInput,
  deps: SectionDeliverDeps = {},
): Promise<RichDeliverResult> {
  const channelId = discordChannelId(input.threadId);
  if (!channelId) return { handled: false };
  if (!input.text.trim() && input.files.length === 0) return { handled: false };

  const build = deps.build ?? buildSectionEmbeds;
  const post = deps.post ?? postSectionEmbeds;

  let built;
  try {
    built = await build(input.text, input.metadata);
  } catch (err) {
    log.error('section-outbound: render failed; falling back to markdown', { err: String(err) });
    return { handled: false };
  }

  // No embeds (blank body) and no agent files → nothing rich to deliver.
  if (built.embeds.length === 0 && input.files.length === 0) return { handled: false };

  const extraFiles: EmbedAttachment[] = input.files.map((f) => ({ name: f.filename, data: f.data }));

  const messageId = await post(
    channelId,
    {
      embeds: built.embeds,
      attachments: built.attachments,
      extraFiles,
      content: built.overflowText || undefined,
    },
    deps,
  );

  // REST post failed (null) → let the bridge fall back to plain markdown.
  if (messageId === null) return { handled: false };
  return { handled: true, messageId };
}
