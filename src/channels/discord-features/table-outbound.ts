/**
 * Outbound table → PNG transform for Discord (additive module).
 *
 * Wires the CJK-safe table renderer ({@link ./table-render}) into the bridge's
 * generic `transformOutboundMessage` seam. For every outbound Discord message
 * it extracts markdown pipe tables, renders each to a PNG (pixel-accurate CJK
 * column widths), and returns the body with those tables replaced by their
 * image attachments. Automatic (not opt-in) — every table the agent emits is
 * fixed, matching the v1 behavior.
 *
 * Degrades safely: if the renderer is unavailable, a table fails to parse or
 * render, or the Discord 10-attachment budget is exhausted, the affected table
 * is left as its original markdown (never dropped, never crashes delivery).
 *
 * Additive: no upstream-core logic changes — see docs/UPSTREAM-MERGE.md. Wired
 * by `discord.ts` via `createChatSdkBridge({ transformOutboundMessage })`.
 */
import { log } from '../../log.js';
import type { OutboundFileUpload, OutboundMessageTransform } from '../chat-sdk-bridge.js';
import { parsePipeTable, renderTableToPng, TABLE_RENDER_AVAILABLE, type ParsedTable } from './table-render.js';

/** Discord allows at most 10 attachments per message. */
const DISCORD_MAX_ATTACHMENTS = 10;

/**
 * A full pipe-table row: contains a pipe and (trimmed) both starts and ends
 * with one. Mirrors the v1 extractor so prose lines that merely contain a `|`
 * aren't swept into a table block.
 */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/**
 * Extract pipe tables from `msg.text`, render each to a PNG attachment, and
 * return `{ text, files }` with rendered tables removed from the body and their
 * PNGs appended to `files`. Returns the input unchanged when there's nothing to
 * render. Intended as a `ChatSdkBridgeConfig.transformOutboundMessage`.
 */
export interface TableRenderDeps {
  /** Render a parsed table to a PNG buffer (null on failure). Injectable for tests. */
  render?: (table: ParsedTable) => Promise<Buffer | null>;
  /** Whether the renderer is available. Defaults to the module-load probe. */
  available?: boolean;
}

export async function renderOutboundTables(
  msg: OutboundMessageTransform,
  deps: TableRenderDeps = {},
): Promise<OutboundMessageTransform> {
  const available = deps.available ?? TABLE_RENDER_AVAILABLE;
  const render = deps.render ?? renderTableToPng;
  // Fast paths: renderer unavailable, or no pipe char at all → nothing to do.
  if (!available || !msg.text.includes('|')) return msg;

  const lines = msg.text.split('\n');
  const outLines: string[] = [];
  const pngs: OutboundFileUpload[] = [];
  const budget = DISCORD_MAX_ATTACHMENTS - msg.files.length;
  let inCode = false;
  let pending: string[] = [];
  let tableSeq = 0;
  let skipped = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const block = pending;
    pending = [];

    const parsed = parsePipeTable(block);
    if (!parsed) {
      // Not a real table (single row, malformed) — keep verbatim.
      outLines.push(...block);
      return;
    }
    if (pngs.length >= budget) {
      // Discord attachment budget exhausted — keep this table as markdown
      // rather than silently dropping it.
      skipped++;
      outLines.push(...block);
      return;
    }
    const png = await render(parsed);
    if (!png) {
      // Render failed — markdown fallback (logged inside renderTableToPng).
      outLines.push(...block);
      return;
    }
    tableSeq++;
    pngs.push({ data: png, filename: `table_${tableSeq}.png` });
    // The table is replaced by its PNG attachment, so emit nothing here.
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      await flush();
      inCode = !inCode;
      outLines.push(line);
      continue;
    }
    if (inCode) {
      outLines.push(line);
      continue;
    }
    if (isTableRow(line)) {
      pending.push(line);
      continue;
    }
    await flush();
    outLines.push(line);
  }
  await flush();

  if (skipped > 0) {
    log.warn('table-render: Discord attachment budget exceeded; left tables as markdown', {
      skipped,
      rendered: pngs.length,
      existingFiles: msg.files.length,
    });
  }
  if (pngs.length === 0) return msg;

  // Collapse blank-line runs left where tables were removed.
  const text = outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, files: [...msg.files, ...pngs] };
}
