/**
 * Opinions store for the discord_notes (#추후-수정) channel.
 *
 * Each opinion is a free-form comment with an author (Discord user). Lives
 * alongside followups under NANOCLAW_DATA_DIR. Markdown view is regenerated
 * on every change.
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

const OPINIONS_JSON = path.join(DATA_DIR, 'opinions.json');
const OPINIONS_MD = path.join(DATA_DIR, 'opinions.md');
const OPINIONS_STATE_JSON = path.join(DATA_DIR, 'opinions-state.json');

export interface OpinionItem {
  id: number;
  content: string;
  authorName: string;
  authorId: string;
  createdAt: string;
  linkedFollowupId?: number;
}

interface OpinionsState {
  nextId: number;
}

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

function loadOpinions(): OpinionItem[] {
  return readJson<OpinionItem[]>(OPINIONS_JSON, []);
}

function loadState(): OpinionsState {
  return readJson<OpinionsState>(OPINIONS_STATE_JSON, { nextId: 1 });
}

function saveState(s: OpinionsState): void {
  writeJson(OPINIONS_STATE_JSON, s);
}

function regenerateMarkdown(): void {
  const items = loadOpinions();
  const lines: string[] = [
    '# 의견 모음',
    '',
    `마지막 업데이트: ${new Date().toISOString()}`,
    `총 ${items.length}건`,
    '',
  ];
  if (items.length === 0) lines.push('_등록된 의견 없음_');
  for (const it of items) {
    lines.push(`## #${String(it.id).padStart(3, '0')} — ${it.authorName}`);
    lines.push(`- 작성: ${it.createdAt.slice(0, 10)}`);
    lines.push(`- 내용:`);
    lines.push('');
    for (const ln of it.content.split('\n')) lines.push(`  > ${ln}`);
    lines.push('');
  }
  fs.writeFileSync(OPINIONS_MD, lines.join('\n'), 'utf-8');
}

export interface NewOpinionInput {
  content: string;
  authorName: string;
  authorId: string;
  createdAt?: string;
  linkedFollowupId?: number;
}

export function add(input: NewOpinionInput): OpinionItem {
  ensureDir();
  const items = loadOpinions();
  const state = loadState();
  const item: OpinionItem = {
    id: state.nextId,
    content: input.content.trim(),
    authorName: input.authorName,
    authorId: input.authorId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    linkedFollowupId: input.linkedFollowupId,
  };
  items.push(item);
  state.nextId++;
  writeJson(OPINIONS_JSON, items);
  saveState(state);
  regenerateMarkdown();
  return item;
}

export function remove(id: number): OpinionItem | null {
  const items = loadOpinions();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  const [it] = items.splice(idx, 1);
  writeJson(OPINIONS_JSON, items);
  regenerateMarkdown();
  return it;
}

export function list(): OpinionItem[] {
  return loadOpinions()
    .slice()
    .sort((a, b) => b.id - a.id);
}

export function count(): number {
  return loadOpinions().length;
}

export function bootstrap(): void {
  ensureDir();
  if (!fs.existsSync(OPINIONS_JSON)) writeJson(OPINIONS_JSON, []);
  if (!fs.existsSync(OPINIONS_STATE_JSON)) saveState({ nextId: 1 });
  regenerateMarkdown();
}
