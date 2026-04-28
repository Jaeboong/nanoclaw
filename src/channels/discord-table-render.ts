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

// Inline-markdown runs. Cell text is parsed into a sequence of runs so that
// `**bold**` segments can render with the bold font variant while the rest
// uses the regular font — all within the same visual line.
type Run = { text: string; bold: boolean };
type WrappedLine = Run[];

const REG_FONT = `${FONT_SIZE}px ${STACK}`;
const BOLD_FONT = `bold ${FONT_SIZE}px ${STACK_BOLD}`;

function parseInlineRuns(text: string, forceBold: boolean): Run[] {
  if (forceBold) {
    // Header cells render bold uniformly — strip ** decorators so literal
    // asterisks don't slip through.
    return [{ text: text.replace(/\*\*(.+?)\*\*/g, '$1'), bold: true }];
  }
  const runs: Run[] = [];
  const re = /\*\*([^*\n]+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      runs.push({ text: text.slice(last, m.index), bold: false });
    }
    runs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    runs.push({ text: text.slice(last), bold: false });
  }
  return runs.length > 0 ? runs : [{ text, bold: false }];
}

type DrawingContext = {
  font: string;
  measureText: (s: string) => { width: number };
  fillText: (s: string, x: number, y: number) => void;
};

type MeasuringContext = Pick<DrawingContext, 'font' | 'measureText'>;

function measureLine(ctx: MeasuringContext, line: WrappedLine): number {
  let w = 0;
  for (const r of line) {
    ctx.font = r.bold ? BOLD_FONT : REG_FONT;
    w += ctx.measureText(r.text).width;
  }
  return w;
}

function drawLine(
  ctx: DrawingContext,
  line: WrappedLine,
  x: number,
  y: number,
): void {
  let cx = x;
  for (const r of line) {
    ctx.font = r.bold ? BOLD_FONT : REG_FONT;
    ctx.fillText(r.text, cx, y);
    cx += ctx.measureText(r.text).width;
  }
}

// Wrap one cell's text into visual lines while preserving bold runs.
// - Honors hard line breaks (`\n`).
// - Greedy-fills by atom (word/whitespace piece), flushing when maxW is exceeded.
// - For atoms wider than maxW (e.g. long unbroken CJK strings), falls back
//   to per-character breaking.
function wrapCell(
  ctx: MeasuringContext,
  text: string,
  maxW: number,
  forceBold: boolean,
): WrappedLine[] {
  if (!text) return [[]];
  const runs = parseInlineRuns(text, forceBold);

  // Split runs at \n into hard-lines (each a Run[]).
  const hardLines: Run[][] = [[]];
  for (const r of runs) {
    const parts = r.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) hardLines.push([]);
      if (parts[i]) {
        hardLines[hardLines.length - 1].push({ text: parts[i], bold: r.bold });
      }
    }
  }

  const out: WrappedLine[] = [];
  for (const hl of hardLines) {
    if (hl.length === 0) {
      out.push([]);
      continue;
    }
    if (measureLine(ctx, hl) <= maxW) {
      out.push(hl);
      continue;
    }

    // Atomize: split each run into word/whitespace pieces, preserving bold.
    const atoms: Run[] = [];
    for (const r of hl) {
      const pieces = r.text.split(/(\s+)/).filter((p) => p !== '');
      for (const p of pieces) atoms.push({ text: p, bold: r.bold });
    }

    let cur: WrappedLine = [];
    let curW = 0;

    const pushAtom = (a: Run) => {
      const last = cur[cur.length - 1];
      if (last && last.bold === a.bold) last.text += a.text;
      else cur.push({ text: a.text, bold: a.bold });
    };

    const flush = () => {
      while (cur.length > 0) {
        const last = cur[cur.length - 1];
        const trimmed = last.text.trimEnd();
        if (trimmed === '') cur.pop();
        else {
          last.text = trimmed;
          break;
        }
      }
      if (cur.length > 0) out.push(cur);
      cur = [];
      curW = 0;
    };

    for (const a of atoms) {
      ctx.font = a.bold ? BOLD_FONT : REG_FONT;
      const aw = ctx.measureText(a.text).width;
      if (curW + aw <= maxW) {
        pushAtom(a);
        curW += aw;
        continue;
      }
      flush();
      if (aw > maxW) {
        // Atom doesn't fit on its own; break by character.
        let chunk = '';
        let chunkW = 0;
        ctx.font = a.bold ? BOLD_FONT : REG_FONT;
        for (const ch of Array.from(a.text)) {
          const chW = ctx.measureText(ch).width;
          if (chunkW + chW <= maxW) {
            chunk += ch;
            chunkW += chW;
          } else {
            if (chunk) out.push([{ text: chunk, bold: a.bold }]);
            chunk = ch;
            chunkW = chW;
          }
        }
        if (chunk) {
          cur = [{ text: chunk, bold: a.bold }];
          curW = chunkW;
        }
      } else if (/^\s+$/.test(a.text)) {
        // Pure whitespace at line start — skip.
        continue;
      } else {
        pushAtom(a);
        curW = aw;
      }
    }
    flush();
  }
  return out.length > 0 ? out : [[]];
}

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

    const wrap = (text: string, forceBold = false): WrappedLine[] =>
      wrapCell(pctx, text, maxCol, forceBold);

    const headerLines = table.headers.map((h) => wrap(h, true));
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
        maxW = Math.max(maxW, measureLine(pctx, line));
      }
      for (const row of rowLines) {
        for (const line of row[c]) {
          maxW = Math.max(maxW, measureLine(pctx, line));
        }
      }
      if (overflowLines) {
        for (const line of overflowLines[c]) {
          maxW = Math.max(maxW, measureLine(pctx, line));
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
    {
      let x = 0;
      for (let c = 0; c < colCount; c++) {
        const lines = headerLines[c];
        for (let li = 0; li < lines.length; li++) {
          drawLine(
            ctx,
            lines[li],
            x + CELL_PAD_X,
            CELL_PAD_Y + li * LINE_HEIGHT,
          );
        }
        x += colWidths[c];
      }
    }

    // Body rows with zebra stripes
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
          drawLine(
            ctx,
            lines[li],
            x + CELL_PAD_X,
            y + CELL_PAD_Y + li * LINE_HEIGHT,
          );
        }
        x += colWidths[c];
      }
      y += rowH;
    }

    // Overflow "… N more …" row (muted color)
    if (overflowLines) {
      ctx.fillStyle = COLOR_BG;
      ctx.fillRect(0, y, totalWidth, overflowHeight);
      ctx.fillStyle = '#8a8d91';
      let x = 0;
      for (let c = 0; c < colCount; c++) {
        const lines = overflowLines[c];
        for (let li = 0; li < lines.length; li++) {
          drawLine(
            ctx,
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
