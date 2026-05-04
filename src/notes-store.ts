/**
 * Notes store for the discord_notes (#추후-수정) channel.
 *
 * Source of truth: JSON files under NANOCLAW_DATA_DIR. Markdown view files
 * are regenerated on every change so humans (and the AI agent on
 * natural-language mentions) always see the same data.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile(['NANOCLAW_DATA_DIR']);
const DATA_DIR =
  process.env.NANOCLAW_DATA_DIR ||
  envConfig.NANOCLAW_DATA_DIR ||
  path.join(os.homedir(), 'nanoclaw-data');

const FOLLOWUPS_JSON = path.join(DATA_DIR, 'followups.json');
const FOLLOWUPS_MD = path.join(DATA_DIR, 'followups.md');
const ARCHIVE_JSON = path.join(DATA_DIR, 'archive.json');
const ARCHIVE_MD = path.join(DATA_DIR, 'archive.md');
const STATE_JSON = path.join(DATA_DIR, 'state.json');

export type Priority = 'high' | 'mid' | 'low';
export type Status = 'open' | 'done' | 'cancelled';

export interface FollowupItem {
  id: number;
  title: string;
  category: string;
  priority: Priority;
  status: Status;
  registeredBy: string;
  registeredAt: string;
  updatedAt: string;
}

export interface NotesState {
  nextId: number;
  filter: { category: string };
}

const PRIORITY_LABEL: Record<Priority, string> = {
  high: '상',
  mid: '중',
  low: '낮',
};

const STATUS_LABEL: Record<Status, string> = {
  open: '대기',
  done: '완료',
  cancelled: '취소',
};

const DEFAULT_CATEGORIES = ['be', 'fe', 'infra', 'docs', 'etc'];

function ensureDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function loadFollowups(): FollowupItem[] {
  return readJson<FollowupItem[]>(FOLLOWUPS_JSON, []);
}

function loadArchive(): FollowupItem[] {
  return readJson<FollowupItem[]>(ARCHIVE_JSON, []);
}

function loadState(): NotesState {
  return readJson<NotesState>(STATE_JSON, {
    nextId: 1,
    filter: { category: 'all' },
  });
}

function saveState(s: NotesState): void {
  writeJson(STATE_JSON, s);
}

function regenerateMarkdown(): void {
  const items = loadFollowups();
  const lines: string[] = [
    '# 추후-수정 리스트',
    '',
    `마지막 업데이트: ${new Date().toISOString()}`,
    `총 ${items.length}건`,
    '',
  ];
  if (items.length === 0) {
    lines.push('_등록된 항목 없음_');
  }
  for (const item of items) {
    lines.push(
      `## #${String(item.id).padStart(3, '0')} [${item.category}] ${item.title}`,
    );
    lines.push(
      `- 등록자: ${item.registeredBy} (${item.registeredAt.slice(0, 10)})`,
    );
    lines.push(`- 우선순위: ${PRIORITY_LABEL[item.priority]}`);
    lines.push(`- 상태: ${STATUS_LABEL[item.status]}`);
    lines.push('');
  }
  fs.writeFileSync(FOLLOWUPS_MD, lines.join('\n'), 'utf-8');

  const archive = loadArchive();
  const aLines: string[] = [
    '# 보관함 (완료/취소된 항목)',
    '',
    `총 ${archive.length}건`,
    '',
  ];
  for (const item of archive) {
    aLines.push(
      `## #${String(item.id).padStart(3, '0')} [${item.category}] ${item.title} — ${STATUS_LABEL[item.status]}`,
    );
    aLines.push(
      `- 등록자: ${item.registeredBy} (${item.registeredAt.slice(0, 10)})`,
    );
    aLines.push(`- 마무리: ${item.updatedAt.slice(0, 10)}`);
    aLines.push('');
  }
  fs.writeFileSync(ARCHIVE_MD, aLines.join('\n'), 'utf-8');
}

export interface NewItemInput {
  title: string;
  category?: string;
  priority?: Priority;
  registeredBy: string;
}

export function add(input: NewItemInput): FollowupItem {
  ensureDir();
  const items = loadFollowups();
  const state = loadState();
  const now = new Date().toISOString();
  const item: FollowupItem = {
    id: state.nextId,
    title: input.title.trim(),
    category: (input.category ?? 'etc').toLowerCase().trim(),
    priority: input.priority ?? 'mid',
    status: 'open',
    registeredBy: input.registeredBy,
    registeredAt: now,
    updatedAt: now,
  };
  items.push(item);
  state.nextId++;
  writeJson(FOLLOWUPS_JSON, items);
  saveState(state);
  regenerateMarkdown();
  return item;
}

export interface UpdateInput {
  id: number;
  title?: string;
  category?: string;
  priority?: Priority;
}

export function update(input: UpdateInput): FollowupItem | null {
  const items = loadFollowups();
  const idx = items.findIndex((i) => i.id === input.id);
  if (idx === -1) return null;
  const item = items[idx];
  if (input.title !== undefined) item.title = input.title.trim();
  if (input.category !== undefined)
    item.category = input.category.toLowerCase().trim();
  if (input.priority !== undefined) item.priority = input.priority;
  item.updatedAt = new Date().toISOString();
  writeJson(FOLLOWUPS_JSON, items);
  regenerateMarkdown();
  return item;
}

export function complete(id: number): FollowupItem | null {
  return moveToArchive(id, 'done');
}

export function cancel(id: number): FollowupItem | null {
  return moveToArchive(id, 'cancelled');
}

function moveToArchive(id: number, newStatus: Status): FollowupItem | null {
  const items = loadFollowups();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  const item = items[idx];
  item.status = newStatus;
  item.updatedAt = new Date().toISOString();
  items.splice(idx, 1);
  const archive = loadArchive();
  archive.unshift(item);
  writeJson(FOLLOWUPS_JSON, items);
  writeJson(ARCHIVE_JSON, archive);
  regenerateMarkdown();
  return item;
}

export function remove(id: number): FollowupItem | null {
  const items = loadFollowups();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  const [item] = items.splice(idx, 1);
  writeJson(FOLLOWUPS_JSON, items);
  regenerateMarkdown();
  return item;
}

export function list(opts: { category?: string } = {}): FollowupItem[] {
  let items = loadFollowups();
  const cat = opts.category;
  if (cat && cat !== 'all') {
    if (cat === 'urgent') {
      items = items.filter((i) => i.priority === 'high');
    } else {
      items = items.filter((i) => i.category === cat);
    }
  }
  // High priority first, then by id asc (#001 at top within same priority)
  const order: Record<Priority, number> = { high: 0, mid: 1, low: 2 };
  return items.sort((a, b) => {
    if (order[a.priority] !== order[b.priority])
      return order[a.priority] - order[b.priority];
    return a.id - b.id;
  });
}

export function search(keyword: string): FollowupItem[] {
  const k = keyword.toLowerCase();
  return loadFollowups().filter(
    (i) =>
      i.title.toLowerCase().includes(k) || i.category.toLowerCase().includes(k),
  );
}

export interface Stats {
  total: number;
  byCategory: Record<string, number>;
  byPriority: Record<Priority, number>;
  byStatus: Record<Status, number>;
  archived: number;
}

export function stats(): Stats {
  const items = loadFollowups();
  const archive = loadArchive();
  const result: Stats = {
    total: items.length,
    byCategory: {},
    byPriority: { high: 0, mid: 0, low: 0 },
    byStatus: { open: 0, done: 0, cancelled: 0 },
    archived: archive.length,
  };
  for (const i of items) {
    result.byCategory[i.category] = (result.byCategory[i.category] ?? 0) + 1;
    result.byPriority[i.priority]++;
    result.byStatus[i.status]++;
  }
  for (const i of archive) {
    result.byStatus[i.status]++;
  }
  return result;
}

export function getArchive(): FollowupItem[] {
  return loadArchive();
}

export function getFilterCategory(): string {
  return loadState().filter.category;
}

export function setFilterCategory(category: string): void {
  const state = loadState();
  state.filter.category = category;
  saveState(state);
}

export function categories(): string[] {
  const items = loadFollowups();
  const set = new Set<string>(DEFAULT_CATEGORIES);
  for (const i of items) set.add(i.category);
  return Array.from(set).sort();
}

export function bootstrap(): void {
  ensureDir();
  if (!fs.existsSync(FOLLOWUPS_JSON)) writeJson(FOLLOWUPS_JSON, []);
  if (!fs.existsSync(ARCHIVE_JSON)) writeJson(ARCHIVE_JSON, []);
  if (!fs.existsSync(STATE_JSON))
    saveState({ nextId: 1, filter: { category: 'all' } });
  regenerateMarkdown();
}

export function priorityLabel(p: Priority): string {
  return PRIORITY_LABEL[p];
}

export function statusLabel(s: Status): string {
  return STATUS_LABEL[s];
}
