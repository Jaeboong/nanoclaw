/**
 * Outbound section → colored Discord embeds (additive module).
 *
 * Ports the v1 `discord-sections` renderer onto v2. Parses an agent reply into
 * sections keyed by Korean `## 헤더` markers, maps each to a colored embed box
 * (the "흰/초록/파랑/빨강/노랑/회색 칸" look), renders markdown pipe tables to
 * PNG embeds via {@link ./table-render}, and lifts a leading `--- ... ---`
 * frontmatter block into the first embed's author/title/fields.
 *
 * Pure + framework-free: emits plain {@link DiscordEmbed} JSON (Discord REST
 * embed objects), never discord.js builders, so it can be posted directly via
 * the REST API ({@link ./section-rest}). The chat-adapter card path can only
 * emit a single hard-coded-color embed, so faithful multi-color section boxes
 * require this bypass — see docs/UPSTREAM-MERGE.md.
 *
 * Additive: no upstream-core logic. Wired by `discord.ts` via the bridge's
 * generic `deliverRichMessage` seam (see {@link ./section-outbound}).
 */
import { parsePipeTable, renderTableToPng, TABLE_RENDER_AVAILABLE, type ParsedTable } from './table-render.js';

export type { ParsedTable };

/** Discord REST embed object (subset we emit). Mirrors the Discord API shape. */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  author?: { name: string };
  thumbnail?: { url: string };
  image?: { url: string };
  timestamp?: string;
  footer?: { text: string };
  fields?: ReadonlyArray<{ name: string; value: string; inline?: boolean }>;
}

/** A PNG attachment referenced by an embed via `attachment://<name>`. */
export interface EmbedAttachment {
  name: string;
  data: Buffer;
}

/** Footer inputs. All optional — the footer is omitted when nothing is usable. */
export interface SectionMetadata {
  toolCounts?: {
    read?: number;
    write?: number;
    edit?: number;
    bash?: number;
    search?: number;
    web?: number;
    subagent?: number;
  };
  elapsedMs?: number;
  model?: string;
}

export const EMBED_DESC_LIMIT = 4096;
export const EMBEDS_PER_MESSAGE = 10;

const DEFAULT_COLOR = 0xffffff; // white — no section header
const SECTION_CONFIG: Record<string, { color: number; emoji: string }> = {
  분석: { color: 0x57f287, emoji: '🔍' },
  결론: { color: 0x3498db, emoji: '📌' },
  주의: { color: 0xed4245, emoji: '⚠️' },
  에러: { color: 0xed4245, emoji: '⚠️' },
  질문: { color: 0xfee75c, emoji: '❓' },
  로그: { color: 0x99aab5, emoji: '📋' },
};

// Table placeholder token in sanitized text. Emitted padded with spaces; the
// matcher tolerates the padding being trimmed away (e.g. when a table is the
// sole content of a section, `parseSections` trims the section body).
const TABLE_TOKEN_RE = / ?TABLE_(\d+) ?/g;
const tableToken = (idx: number) => ` TABLE_${idx} `;

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
  return { frontmatter: parseFrontmatterBlock(match[1]), body };
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

export interface SanitizedWithTables {
  text: string;
  tables: ParsedTable[];
}

/**
 * Replace markdown pipe tables with ` TABLE_<n> ` placeholder tokens (collected
 * into `tables`) and normalize a few markdown constructs Discord renders badly
 * (H4+ → bold, task list checkboxes, horizontal rules). Code fences pass
 * through untouched.
 */
export function sanitizeWithTables(text: string): SanitizedWithTables {
  const lines = text.split('\n');
  const out: string[] = [];
  const tables: ParsedTable[] = [];
  let inCodeBlock = false;
  let pendingTable: string[] = [];

  const flushTable = () => {
    if (pendingTable.length === 0) return;
    const parsed = parsePipeTable(pendingTable);
    if (parsed) {
      out.push(tableToken(tables.length));
      tables.push(parsed);
    } else {
      // Malformed table (single row etc.) — preserve as a code block.
      out.push('```', ...pendingTable, '```');
    }
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
  return { text: out.join('\n'), tables };
}

export interface ParsedSection {
  label: string | null; // null → default (white)
  color: number;
  emoji: string | null;
  body: string;
}

function stripLeadingNonLetters(s: string): string {
  return s.replace(/^[^\p{Letter}\p{Number}]+/u, '').trim();
}

/** Split text into colored sections on recognized `## 헤더` markers. */
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
    if (body.length > 0) sections.push({ label, color, emoji, body });
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      buffer.push(line);
      continue;
    }
    if (!inCodeBlock && /^##\s+\S/.test(line)) {
      const headerText = line.replace(/^##\s+/, '').trim();
      const matched = SECTION_CONFIG[stripLeadingNonLetters(headerText)];
      if (matched) {
        flush();
        label = stripLeadingNonLetters(headerText);
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

function formatFooter(metadata: SectionMetadata): string | null {
  const parts: string[] = [];
  if (metadata.toolCounts) {
    const c = metadata.toolCounts;
    const tools: string[] = [];
    const writeCount = (c.write ?? 0) + (c.edit ?? 0);
    if ((c.read ?? 0) > 0) tools.push(`📖 ${c.read}`);
    if (writeCount > 0) tools.push(`✏️ ${writeCount}`);
    if ((c.bash ?? 0) > 0) tools.push(`⚡ ${c.bash}`);
    if ((c.search ?? 0) > 0) tools.push(`🔍 ${c.search}`);
    if ((c.web ?? 0) > 0) tools.push(`🌐 ${c.web}`);
    if ((c.subagent ?? 0) > 0) tools.push(`🤖 ${c.subagent}`);
    if (tools.length > 0) parts.push(tools.join(' · '));
  }
  if (typeof metadata.elapsedMs === 'number' && metadata.elapsedMs > 0) {
    parts.push(`${Math.round(metadata.elapsedMs / 1000)}s`);
  }
  if (metadata.model) parts.push(metadata.model);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function applyFrontmatter(embed: DiscordEmbed, fm: EmbedFrontmatter): void {
  if (fm.author) embed.author = { name: fm.author };
  if (fm.title) embed.title = fm.title;
  if (fm.url) embed.url = fm.url;
  if (fm.thumbnail) embed.thumbnail = { url: fm.thumbnail };
  if (fm.image) embed.image = { url: fm.image };
  if (fm.timestamp === true) {
    embed.timestamp = nowIso();
  } else if (typeof fm.timestamp === 'string') {
    const d = new Date(fm.timestamp);
    if (!isNaN(d.getTime())) embed.timestamp = d.toISOString();
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
    if (valid.length > 0) embed.fields = valid;
  }
}

// Isolated so the rare frontmatter `timestamp: true` path is the only caller of
// a wall-clock read (kept side-effect-local for testability).
function nowIso(): string {
  return new Date().toISOString();
}

export interface BuiltMessage {
  embeds: DiscordEmbed[];
  overflowText: string;
  attachments: EmbedAttachment[];
}

type Piece = { kind: 'text'; text: string } | { kind: 'image'; index: number };

function trimBlock(s: string): string {
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

function splitOnTables(body: string, fallbackText: ReadonlyArray<string | null>): Piece[] {
  const pieces: Piece[] = [];
  let lastIdx = 0;
  TABLE_TOKEN_RE.lastIndex = 0;
  for (;;) {
    const m = TABLE_TOKEN_RE.exec(body);
    if (!m) break;
    const before = body.slice(lastIdx, m.index);
    const idx = Number(m[1]);
    const fallback = fallbackText[idx];
    if (fallback !== null && fallback !== undefined) {
      // Table render unavailable/failed — merge the code block back into text.
      pieces.push({ kind: 'text', text: `${before.replace(/\s+$/, '')}\n${fallback}` });
    } else {
      if (before.trim()) pieces.push({ kind: 'text', text: trimBlock(before) });
      pieces.push({ kind: 'image', index: idx });
    }
    lastIdx = m.index + m[0].length;
  }
  const tail = body.slice(lastIdx);
  if (tail.trim()) pieces.push({ kind: 'text', text: trimBlock(tail) });
  return pieces;
}

function tableToPipeLines(t: ParsedTable): string[] {
  const headerLine = `| ${t.headers.join(' | ')} |`;
  const sep = `|${t.headers.map(() => '---').join('|')}|`;
  return [headerLine, sep, ...t.rows.map((r) => `| ${r.join(' | ')} |`)];
}

/**
 * Render an agent reply into colored section embeds plus PNG table attachments.
 * Returns zero embeds for blank input. Body over {@link EMBED_DESC_LIMIT} is
 * truncated into the embed and the remainder returned in `overflowText` for the
 * caller to deliver as a follow-up plain message.
 */
export async function buildSectionEmbeds(
  text: string,
  metadata?: SectionMetadata,
  deps: { render?: (t: ParsedTable) => Promise<Buffer | null>; available?: boolean } = {},
): Promise<BuiltMessage> {
  const available = deps.available ?? TABLE_RENDER_AVAILABLE;
  const render = deps.render ?? renderTableToPng;

  const { frontmatter, body } = extractFrontmatter(text);
  const { text: tokenized, tables } = sanitizeWithTables(body);

  const pngs: (Buffer | null)[] = available
    ? await Promise.all(tables.map((t) => render(t)))
    : tables.map(() => null);

  // For tables that failed to render, fall back to an inline code block.
  const tableFallback: (string | null)[] = tables.map((t, i) =>
    pngs[i] ? null : ['```', ...tableToPipeLines(t), '```'].join('\n'),
  );

  const sections = parseSections(tokenized);
  if (sections.length === 0) {
    return { embeds: [], overflowText: '', attachments: [] };
  }

  const embeds: DiscordEmbed[] = [];
  const overflowChunks: string[] = [];
  const attachments: EmbedAttachment[] = [];

  for (const section of sections) {
    for (const piece of splitOnTables(section.body, tableFallback)) {
      if (piece.kind === 'text') {
        if (!piece.text.trim()) continue;
        const embed: DiscordEmbed = { color: section.color };
        if (piece.text.length <= EMBED_DESC_LIMIT) {
          embed.description = piece.text;
        } else {
          embed.description = piece.text.slice(0, EMBED_DESC_LIMIT);
          overflowChunks.push(piece.text.slice(EMBED_DESC_LIMIT));
        }
        embeds.push(embed);
      } else {
        const name = `table_${piece.index}.png`;
        attachments.push({ name, data: pngs[piece.index] as Buffer });
        embeds.push({ color: section.color, image: { url: `attachment://${name}` } });
      }
    }
  }

  if (frontmatter && embeds.length > 0) applyFrontmatter(embeds[0], frontmatter);

  if (metadata && embeds.length > 0) {
    const footer = formatFooter(metadata);
    if (footer) embeds[embeds.length - 1].footer = { text: footer };
  }

  return { embeds, overflowText: overflowChunks.join('\n\n'), attachments };
}
