import { EmbedBuilder } from 'discord.js';

import { MessageMetadata } from '../types.js';

export const EMBED_DESC_LIMIT = 4096;
export const EMBEDS_PER_MESSAGE = 10;

export interface EmbedFrontmatter {
  author?: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  image?: string;
  timestamp?: boolean | string;
  fields?: ReadonlyArray<{ name: string; value: string; inline?: boolean }>;
}

const FRONTMATTER_DELIM = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

export function extractFrontmatter(text: string): {
  frontmatter: EmbedFrontmatter | null;
  body: string;
} {
  const match = text.match(FRONTMATTER_DELIM);
  if (!match) return { frontmatter: null, body: text };
  const body = text.slice(match[0].length);
  const fm = parseFrontmatterBlock(match[1]);
  return { frontmatter: fm, body };
}

function parseFrontmatterBlock(raw: string): EmbedFrontmatter | null {
  const result: Record<string, unknown> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!/^[a-zA-Z_][\w]*$/.test(key)) continue;
    if (value === 'true') result[key] = true;
    else if (value === 'false') result[key] = false;
    else if (value.startsWith('[') || value.startsWith('{')) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        continue;
      }
    } else {
      result[key] = value.replace(/^["'](.*)["']$/, '$1');
    }
  }
  return Object.keys(result).length > 0 ? (result as EmbedFrontmatter) : null;
}

export function sanitizeDiscordMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let pendingTable: string[] = [];

  const flushTable = () => {
    if (pendingTable.length === 0) return;
    out.push('```');
    out.push(...pendingTable);
    out.push('```');
    pendingTable = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushTable();
      inCodeBlock = !inCodeBlock;
      out.push(line);
      continue;
    }
    if (inCodeBlock) {
      out.push(line);
      continue;
    }

    // Table rows (including separator) — collect, wrap in code block on flush.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      pendingTable.push(line);
      continue;
    }
    flushTable();

    const h4Plus = line.match(/^(#{4,})\s+(.*)$/);
    if (h4Plus) {
      const content = h4Plus[2].trim();
      out.push(content ? `**${content}**` : '');
      continue;
    }

    const unchecked = line.match(/^(\s*)- \[ \]\s+(.*)$/);
    if (unchecked) {
      out.push(`${unchecked[1]}• ☐ ${unchecked[2]}`);
      continue;
    }
    const checked = line.match(/^(\s*)- \[[xX]\]\s+(.*)$/);
    if (checked) {
      out.push(`${checked[1]}• ☑ ${checked[2]}`);
      continue;
    }

    if (/^-{3,}\s*$/.test(line) || /^\*{3,}\s*$/.test(line)) {
      out.push('');
      continue;
    }

    out.push(line);
  }
  flushTable();
  return out.join('\n');
}

const DEFAULT_COLOR = 0xffffff; // white — no section header
const SECTION_CONFIG: Record<string, { color: number; emoji: string }> = {
  분석: { color: 0x57f287, emoji: '🔍' },
  결론: { color: 0x3498db, emoji: '📌' },
  주의: { color: 0xed4245, emoji: '⚠️' },
  에러: { color: 0xed4245, emoji: '⚠️' },
  질문: { color: 0xfee75c, emoji: '❓' },
  로그: { color: 0x99aab5, emoji: '📋' },
};

export interface ParsedSection {
  label: string | null; // null → default (white)
  color: number;
  emoji: string | null;
  body: string;
}

function stripLeadingNonLetters(s: string): string {
  return s.replace(/^[^\p{Letter}\p{Number}]+/u, '').trim();
}

export function parseSections(text: string): ParsedSection[] {
  const lines = text.split('\n');
  const sections: ParsedSection[] = [];

  let label: string | null = null;
  let color = DEFAULT_COLOR;
  let emoji: string | null = null;
  let buffer: string[] = [];
  let inCodeBlock = false;

  const flush = () => {
    const body = buffer.join('\n').replace(/^\s+|\s+$/g, '');
    if (body.length > 0) {
      sections.push({ label, color, emoji, body });
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      buffer.push(line);
      continue;
    }

    if (!inCodeBlock && /^##\s+\S/.test(line)) {
      const headerText = line.replace(/^##\s+/, '').trim();
      const stripped = stripLeadingNonLetters(headerText);
      const matched = SECTION_CONFIG[stripped];
      if (matched) {
        flush();
        label = stripped;
        color = matched.color;
        emoji = matched.emoji;
        buffer = [];
        continue;
      }
    }

    buffer.push(line);
  }
  flush();
  return sections;
}

function formatFooter(metadata: MessageMetadata): string | null {
  const parts: string[] = [];

  if (metadata.toolCounts) {
    const c = metadata.toolCounts;
    const tools: string[] = [];
    const readCount = c.read ?? 0;
    const writeCount = (c.write ?? 0) + (c.edit ?? 0);
    const bashCount = c.bash ?? 0;
    const searchCount = c.search ?? 0;
    const webCount = c.web ?? 0;
    const subCount = c.subagent ?? 0;
    if (readCount > 0) tools.push(`📖 ${readCount}`);
    if (writeCount > 0) tools.push(`✏️ ${writeCount}`);
    if (bashCount > 0) tools.push(`⚡ ${bashCount}`);
    if (searchCount > 0) tools.push(`🔍 ${searchCount}`);
    if (webCount > 0) tools.push(`🌐 ${webCount}`);
    if (subCount > 0) tools.push(`🤖 ${subCount}`);
    if (tools.length > 0) parts.push(tools.join(' · '));
  }

  if (typeof metadata.elapsedMs === 'number' && metadata.elapsedMs > 0) {
    parts.push(`${Math.round(metadata.elapsedMs / 1000)}s`);
  }
  if (metadata.model) parts.push(metadata.model);

  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface BuiltMessage {
  embeds: EmbedBuilder[];
  overflowText: string;
}

function applyFrontmatter(embed: EmbedBuilder, fm: EmbedFrontmatter): void {
  if (fm.author) embed.setAuthor({ name: fm.author });
  if (fm.title) embed.setTitle(fm.title);
  if (fm.url) embed.setURL(fm.url);
  if (fm.thumbnail) embed.setThumbnail(fm.thumbnail);
  if (fm.image) embed.setImage(fm.image);
  if (fm.timestamp === true) {
    embed.setTimestamp(new Date());
  } else if (typeof fm.timestamp === 'string') {
    const d = new Date(fm.timestamp);
    if (!isNaN(d.getTime())) embed.setTimestamp(d);
  }
  if (Array.isArray(fm.fields)) {
    const valid = fm.fields
      .filter(
        (f): f is { name: string; value: string; inline?: boolean } =>
          !!f &&
          typeof f.name === 'string' &&
          typeof f.value === 'string' &&
          f.name.length > 0 &&
          f.value.length > 0,
      )
      .slice(0, 25)
      .map((f) => ({ name: f.name, value: f.value, inline: !!f.inline }));
    if (valid.length > 0) embed.addFields(...valid);
  }
}

export function buildEmbedsForMessage(
  text: string,
  metadata?: MessageMetadata,
): BuiltMessage {
  const { frontmatter, body } = extractFrontmatter(text);
  const sanitized = sanitizeDiscordMarkdown(body);
  const sections = parseSections(sanitized);
  if (sections.length === 0) {
    return { embeds: [], overflowText: '' };
  }

  const embeds: EmbedBuilder[] = [];
  const overflowChunks: string[] = [];

  for (const section of sections) {
    const eb = new EmbedBuilder().setColor(section.color);
    if (section.body.length <= EMBED_DESC_LIMIT) {
      eb.setDescription(section.body);
    } else {
      eb.setDescription(section.body.slice(0, EMBED_DESC_LIMIT));
      overflowChunks.push(section.body.slice(EMBED_DESC_LIMIT));
    }
    embeds.push(eb);
  }

  if (frontmatter && embeds.length > 0) {
    applyFrontmatter(embeds[0], frontmatter);
  }

  if (metadata && embeds.length > 0) {
    const footer = formatFooter(metadata);
    if (footer) {
      embeds[embeds.length - 1].setFooter({ text: footer });
    }
  }

  return {
    embeds,
    overflowText: overflowChunks.join('\n\n'),
  };
}
