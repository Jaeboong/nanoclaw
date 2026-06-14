/**
 * Pure renderers for the agent-activity panel. No I/O, no Discord SDK — plain
 * markdown text the module hands to the delivery adapter / interaction
 * followups. Kept pure so they are fully deterministic under test.
 *
 * Budget: Discord message content caps at 2000 chars; we clamp to 1900 to stay
 * safe (the compact panel) and paginate the detail view.
 */
import type { ActivityRow, ActivityStatus } from './snapshot.js';

const MAX_BODY = 1900;
const EMPTY = '활성 세션이 없습니다.';

interface Counts {
  readonly total: number;
  readonly working: number;
  readonly thinking: number;
  readonly stopped: number;
}

function tally(rows: readonly ActivityRow[]): Counts {
  let working = 0;
  let thinking = 0;
  let stopped = 0;
  for (const r of rows) {
    if (r.status === 'working') working++;
    else if (r.status === 'thinking') thinking++;
    else stopped++;
  }
  return { total: rows.length, working, thinking, stopped };
}

function statusEmoji(s: ActivityStatus): string {
  return s === 'working' ? '🟢' : s === 'thinking' ? '🟡' : '⚫';
}

function statusText(r: ActivityRow): string {
  if (r.status === 'working') return `🔧 ${r.currentTool} · ${r.elapsedSec}초`;
  if (r.status === 'thinking') return '💭 작업 중…';
  return '⏹ 중지됨';
}

function compactLine(r: ActivityRow): string {
  return `${statusEmoji(r.status)} **${r.agentName}** — ${statusText(r)}`;
}

/**
 * One-line counts summary — the body of the public panel card. Kept short on
 * purpose: the card path renders this in both the message content and the
 * embed (an SDK behavior shared with ask_question), so a single summary line
 * keeps that duplication trivial. The per-session detail lives behind the
 * buttons (ephemeral, plain content — no embed, no duplication).
 */
export function renderSummary(rows: readonly ActivityRow[]): string {
  if (rows.length === 0) return EMPTY;
  const c = tally(rows);
  return (
    `활성 ${c.total} · 🟢 작업 ${c.working} · 🟡 대기 ${c.thinking} · ⚫ 중지 ${c.stopped}\n` +
    '게시 시각 기준 — 🔄 새로고침으로 최신 현황 보기'
  );
}

/**
 * Compact per-session view delivered as an ephemeral followup when Refresh is
 * clicked. Clamped to MAX_BODY; overflow is noted and routed to Details.
 */
export function renderPanel(rows: readonly ActivityRow[]): string {
  if (rows.length === 0) return EMPTY;
  const header = renderSummary(rows);
  const lines: string[] = [];
  let used = header.length + 2;
  for (const r of rows) {
    const line = compactLine(r);
    if (used + line.length + 1 > MAX_BODY) break;
    lines.push(line);
    used += line.length + 1;
  }
  const dropped = rows.length - lines.length;
  let body = `${header}\n\n${lines.join('\n')}`;
  if (dropped > 0) body += `\n…외 ${dropped}개 (📋 상세)`;
  return body;
}

function detailBlock(r: ActivityRow): string {
  const chat = r.chat ?? '—';
  return `${statusEmoji(r.status)} **${r.agentName}**  ·  ${chat}\n   ${statusText(r)}  ·  세션 \`${r.sessionId}\``;
}

/**
 * Full per-session detail, paginated into ≤MAX_BODY pages. The Details button
 * shows page 0 (a single ephemeral followup); callers note any truncation.
 * Returns [] when there is nothing active.
 */
export function renderDetails(rows: readonly ActivityRow[]): readonly string[] {
  if (rows.length === 0) return [];
  const pages: string[] = [];
  let cur = '';
  for (const r of rows) {
    const block = detailBlock(r);
    if (cur && cur.length + block.length + 2 > MAX_BODY) {
      pages.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${block}` : block;
  }
  if (cur) pages.push(cur);
  return pages;
}
