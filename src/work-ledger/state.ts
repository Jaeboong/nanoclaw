import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';

export type Side = 'fe' | 'be';

export interface NonJiraTodo {
  id: string;
  text: string;
  side: Side;
  createdAt: string;
}

export type SuggestionAction =
  | { kind: 'transition'; status: string }
  | {
      kind: 'create';
      type: 'Task' | 'Story';
      summary: string;
      points?: number;
    };

export interface JiraSuggestion {
  id: string;
  source: 'mr_merged' | 'push' | 'manual';
  triggerRef?: string; // e.g. 'fe/feat/foo'
  candidateIssueKey?: string; // best guess
  confidence: number; // 0..1
  action: SuggestionAction;
  reasoning: string;
  createdAt: string;
}

export interface JiraIssueCache {
  key: string;
  summary: string;
  status: string;
  statusCategory: string; // 'To Do' | 'In Progress' | 'Done'
  type: string;
  assignee: string | null;
  url: string;
  parentKey?: string | null;
  parentSummary?: string | null;
}

export interface WorkLedgerState {
  jiraPanelMessageId: string | null;
  nonJiraPanelMessageId: string | null;
  suggestionsPanelMessageId: string | null;
  /** Set only on schema migration from the previous combined-panel build. */
  legacyCombinedPanelMessageId?: string | null;
  nonJiraTodos: NonJiraTodo[];
  suggestions: JiraSuggestion[];
  jiraIssues: JiraIssueCache[];
  lastJiraFetch: string | null; // ISO
}

const STATE_DIR = '/home/ubuntu/ddonyang/work-ledger';
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const EMPTY: WorkLedgerState = {
  jiraPanelMessageId: null,
  nonJiraPanelMessageId: null,
  suggestionsPanelMessageId: null,
  nonJiraTodos: [],
  suggestions: [],
  jiraIssues: [],
  lastJiraFetch: null,
};

export function loadState(): WorkLedgerState {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      return structuredClone(EMPTY);
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WorkLedgerState> & {
      workPanelMessageId?: string | null;
    };
    // Schema migration: previous build had a single combined `workPanelMessageId`.
    // Carry it over as `legacyCombinedPanelMessageId` so the next refresh nukes it.
    if (parsed.workPanelMessageId && !parsed.jiraPanelMessageId) {
      parsed.legacyCombinedPanelMessageId = parsed.workPanelMessageId;
      delete parsed.workPanelMessageId;
    }
    return { ...EMPTY, ...parsed };
  } catch (err) {
    logger.warn({ err }, 'work-ledger state load failed; starting empty');
    return structuredClone(EMPTY);
  }
}

export function saveState(state: WorkLedgerState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_FILE);
}

export function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
