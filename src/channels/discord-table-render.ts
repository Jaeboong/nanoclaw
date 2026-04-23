// Renders markdown pipe tables as PNG buffers for Discord.
//
// Discord has no native table rendering — the conventional workaround (wrap in
// a ``` code block) misaligns for CJK/emoji because pipe chars are the only
// separator and column widths don't compensate for double-width glyphs.
//
// This module parses `|...|` tables and draws them onto an @napi-rs/canvas
// surface using measureText() for pixel-accurate column widths, producing a
// PNG that Discord displays via `setImage('attachment://...')`.
//
// @napi-rs/canvas is optional — if it fails to load (missing prebuilt binary,
// arch mismatch, etc.) we export TABLE_RENDER_AVAILABLE=false and callers
// fall back to the legacy code-block behavior.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import { logger } from '../logger.js';

type CanvasModule = typeof import('@napi-rs/canvas');

// @napi-rs/canvas does glyph-level fallback via CSS font-stack syntax, not by
// co-registering multiple files under one family. Each file gets its own family
// and the renderer passes them as a comma-separated stack.
const FAM_MONO = 'NTMono';
const FAM_KR = 'NTKR';
const FAM_EMOJI = 'NTEmoji';
const FAM_MONO_B = 'NTMonoB';
const FAM_KR_B = 'NTKRB';

const STACK = `"${FAM_MONO}", "${FAM_KR}", "${FAM_EMOJI}"`;
const STACK_BOLD = `"${FAM_MONO_B}", "${FAM_KR_B}", "${FAM_EMOJI}"`;

const nodeRequire = createRequire(import.meta.url);

let canvasMod: CanvasModule | null = null;
let loadError: string | null = null;

function loadCanvas(): CanvasModule | null {
  if (canvasMod) return canvasMod;
  if (loadError) return null;
  try {
    const mod = nodeRequire('@napi-rs/canvas') as CanvasModule;
    const fontsDir = resolveFontsDir();
    if (!fontsDir) {
      loadError = 'fonts_dir_not_found';
      logger.warn('Discord table renderer: fonts directory not found');
      return null;
    }
    mod.GlobalFonts.registerFromPath(
      resolve(fontsDir, 'NotoSansMono-Regular.ttf'),
      FAM_MONO,
    );
    mod.GlobalFonts.registerFromPath(
      resolve(fontsDir, 'NotoSansMono-Bold.ttf'),
      FAM_MONO_B,
    );
    mod.GlobalFonts.registerFromPath(
      resolve(fontsDir, 'NotoSansKR-Regular.otf'),
      FAM_KR,
    );
    mod.GlobalFonts.registerFromPath(
      resolve(fontsDir, 'NotoSansKR-Bold.otf'),
      FAM_KR_B,
    );
    mod.GlobalFonts.registerFromPath(
      resolve(fontsDir, 'NotoEmoji-Regular.ttf'),
      FAM_EMOJI,
    );
    canvasMod = mod;
    return mod;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err: loadError },
      'Discord table renderer unavailable; falling back to code blocks',
    );
    return null;
  }
}

function resolveFontsDir(): string | null {
  // Module lives at dist/channels (compiled JS) or src/channels (tsx).
  // Walk up to find assets/fonts at the repo root.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'assets/fonts');
    if (existsSync(candidate)) return candidate;
    dir = resolve(dir, '..');
  }
  return null;
}

export const TABLE_RENDER_AVAILABLE = loadCanvas() !== null;

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

// Tolerant pipe-table parser. Accepts:
//   | H1 | H2 |
//   |---|---|    ← alignment row, optional, stripped
//   | a  | b  |
// Leading/trailing pipes optional. Cells are trimmed.
// Returns null if fewer than 2 non-alignment rows (header + at least one body).
export function parsePipeTable(lines: string[]): ParsedTable | null {
  const rows = lines
    .map((l) => splitPipeRow(l))
    .filter((r): r is string[] => r !== null);
  if (rows.length < 2) return null;

  // Drop alignment row if present (all cells match ^:?-+:?$).
  const alignmentIdx = rows.findIndex((row) =>
    row.every((c) => /^:?-{2,}:?$/.test(c.trim())),
  );
  if (alignmentIdx > 0 && alignmentIdx < rows.length) {
    rows.splice(alignmentIdx, 1);
  }
  if (rows.length < 2) return null;

  const headers = rows[0];
  const body = rows.slice(1);
  const colCount = headers.length;
  // Pad/truncate rows to match header column count.
  const normalized = body.map((r) => {
    if (r.length === colCount) return r;
    if (r.length < colCount) {
      return [...r, ...Array(colCount - r.length).fill('')];
    }
    return r.slice(0, colCount);
  });
  return { headers, rows: normalized };
}

function splitPipeRow(line: string): string[] | null {
  if (!/\|/.test(line)) return null;
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') && !trimmed.endsWith('|')) return null;
  // Strip leading/trailing pipe, then split on unescaped pipes.
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

export interface RenderOpts {
  scale?: number; // device-pixel multiplier (default 2)
  maxColWidth?: number; // logical px (default 220)
  maxRows?: number; // soft cap on rows before "…more…" (default 50)
}

const FONT_SIZE = 14; // logical px
const LINE_HEIGHT = 20;
const CELL_PAD_X = 12;
const CELL_PAD_Y = 8;

const COLOR_BG = '#2b2d31'; // Discord dark
const COLOR_BG_ALT = '#313338';
const COLOR_HEADER = '#5865f2'; // Discord blurple
const COLOR_HEADER_TEXT = '#ffffff';
const COLOR_TEXT = '#dcddde';
const COLOR_BORDER = '#3f4147';

export async function renderTableToPng(
  table: ParsedTable,
  opts: RenderOpts = {},
): Promise<Buffer | null> {
  const mod = loadCanvas();
  if (!mod) return null;

  const scale = opts.scale ?? 2;
  const maxCol = opts.maxColWidth ?? 220;
  const maxRows = opts.maxRows ?? 50;

  try {
    // Truncate rows beyond maxRows, add a trailing "…N more rows" summary row.
    let rows = table.rows;
    let overflowNote: string[] | null = null;
    if (rows.length > maxRows) {
      const omitted = rows.length - (maxRows - 1);
      rows = rows.slice(0, maxRows - 1);
      overflowNote = Array(table.headers.length).fill('');
      overflowNote[0] = `… ${omitted}개 행 생략`;
    }

    // Measure pass — uses a throwaway canvas just to get a measuring context.
    const probe = mod.createCanvas(1, 1);
    const pctx = probe.getContext('2d');
    pctx.font = `${FONT_SIZE}px ${STACK}`;

    // Wrap each cell to maxCol, collect line arrays per (row, col).
    const wrap = (text: string): string[] => wrapText(pctx, text, maxCol);

    const headerLines = table.headers.map((h) => wrap(h));
    const rowLines = rows.map((r) => r.map((c) => wrap(c)));
    const overflowLines = overflowNote
      ? overflowNote.map((c) => wrap(c))
      : null;

    // Per-column width: max measured width across all cells' longest line, capped.
    const colCount = table.headers.length;
    const colWidths: number[] = [];
    for (let c = 0; c < colCount; c++) {
      let maxW = 0;
      for (const line of headerLines[c]) {
        maxW = Math.max(maxW, pctx.measureText(line).width);
      }
      for (const row of rowLines) {
        for (const line of row[c]) {
          maxW = Math.max(maxW, pctx.measureText(line).width);
        }
      }
      if (overflowLines) {
        for (const line of overflowLines[c]) {
          maxW = Math.max(maxW, pctx.measureText(line).width);
        }
      }
      colWidths.push(Math.min(maxW, maxCol) + CELL_PAD_X * 2);
    }

    // Per-row height: max line count in row × LINE_HEIGHT + vertical padding.
    const headerHeight =
      Math.max(...headerLines.map((l) => l.length)) * LINE_HEIGHT +
      CELL_PAD_Y * 2;
    const bodyHeights = rowLines.map(
      (row) =>
        Math.max(...row.map((l) => l.length)) * LINE_HEIGHT + CELL_PAD_Y * 2,
    );
    const overflowHeight = overflowLines
      ? Math.max(...overflowLines.map((l) => l.length)) * LINE_HEIGHT +
        CELL_PAD_Y * 2
      : 0;

    const totalWidth = colWidths.reduce((a, b) => a + b, 0) + 1;
    const totalHeight =
      headerHeight +
      bodyHeights.reduce((a, b) => a + b, 0) +
      overflowHeight +
      1;

    const canvas = mod.createCanvas(
      Math.ceil(totalWidth * scale),
      Math.ceil(totalHeight * scale),
    );
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.textBaseline = 'top';

    // Header row
    ctx.fillStyle = COLOR_HEADER;
    ctx.fillRect(0, 0, totalWidth, headerHeight);
    ctx.fillStyle = COLOR_HEADER_TEXT;
    ctx.font = `bold ${FONT_SIZE}px ${STACK_BOLD}`;
    {
      let x = 0;
      for (let c = 0; c < colCount; c++) {
        const lines = headerLines[c];
        for (let li = 0; li < lines.length; li++) {
          ctx.fillText(
            lines[li],
            x + CELL_PAD_X,
            CELL_PAD_Y + li * LINE_HEIGHT,
          );
        }
        x += colWidths[c];
      }
    }

    // Body rows with zebra stripes
    ctx.font = `${FONT_SIZE}px ${STACK}`;
    let y = headerHeight;
    for (let r = 0; r < rowLines.length; r++) {
      const rowH = bodyHeights[r];
      ctx.fillStyle = r % 2 === 0 ? COLOR_BG : COLOR_BG_ALT;
      ctx.fillRect(0, y, totalWidth, rowH);
      ctx.fillStyle = COLOR_TEXT;
      let x = 0;
      for (let c = 0; c < colCount; c++) {
        const lines = rowLines[r][c];
        for (let li = 0; li < lines.length; li++) {
          ctx.fillText(
            lines[li],
            x + CELL_PAD_X,
            y + CELL_PAD_Y + li * LINE_HEIGHT,
          );
        }
        x += colWidths[c];
      }
      y += rowH;
    }

    // Overflow "… N more …" row (muted color, italic not available without separate font)
    if (overflowLines) {
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, y, totalWidth, overflowHeight);
      ctx.fillStyle = '#8a8d91';
      let x = 0;
      for (let c = 0; c < colCount; c++) {
        const lines = overflowLines[c];
        for (let li = 0; li < lines.length; li++) {
          ctx.fillText(
            lines[li],
            x + CELL_PAD_X,
            y + CELL_PAD_Y + li * LINE_HEIGHT,
          );
        }
        x += colWidths[c];
      }
      y += overflowHeight;
    }

    // Borders — outer rectangle + column separators + row separators
    ctx.strokeStyle = COLOR_BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, totalWidth - 1, totalHeight - 1);
    // Column separators
    {
      let x = 0;
      for (let c = 0; c < colCount - 1; c++) {
        x += colWidths[c];
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, totalHeight);
        ctx.stroke();
      }
    }
    // Row separators (between header and body, and between body rows)
    {
      let ry = headerHeight;
      ctx.beginPath();
      ctx.moveTo(0, ry + 0.5);
      ctx.lineTo(totalWidth, ry + 0.5);
      ctx.stroke();
      for (const h of bodyHeights) {
        ry += h;
        ctx.beginPath();
        ctx.moveTo(0, ry + 0.5);
        ctx.lineTo(totalWidth, ry + 0.5);
        ctx.stroke();
      }
    }

    return await canvas.encode('png');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Discord table render failed; falling back to code block',
    );
    return null;
  }
}

type MeasuringContext = { measureText: (s: string) => { width: number } };

function wrapText(
  ctx: MeasuringContext,
  text: string,
  maxWidth: number,
): string[] {
  if (!text) return [''];
  const hardLines = text.split('\n');
  const out: string[] = [];
  for (const hardLine of hardLines) {
    if (ctx.measureText(hardLine).width <= maxWidth) {
      out.push(hardLine);
      continue;
    }
    // Word-wrap; preserve inter-word spaces in the resulting lines.
    const parts = hardLine.split(/(\s+)/);
    let cur = '';
    for (const p of parts) {
      const trial = cur + p;
      if (ctx.measureText(trial).width <= maxWidth) {
        cur = trial;
        continue;
      }
      if (cur.trim()) out.push(cur.trimEnd());
      // Single piece exceeds maxWidth on its own — char-break.
      if (ctx.measureText(p).width > maxWidth) {
        let chunk = '';
        for (const ch of Array.from(p)) {
          if (ctx.measureText(chunk + ch).width <= maxWidth) {
            chunk += ch;
          } else {
            if (chunk) out.push(chunk);
            chunk = ch;
          }
        }
        cur = chunk;
      } else {
        cur = p.trimStart();
      }
    }
    if (cur.trim()) out.push(cur.trimEnd());
  }
  return out.length > 0 ? out : [''];
}
