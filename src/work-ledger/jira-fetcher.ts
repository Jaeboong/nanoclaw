import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../logger.js';
import { JiraIssueCache } from './state.js';

interface JiraEnv {
  url: string;
  email: string;
  token: string;
  projectKey: string;
}

function readJiraEnv(): JiraEnv | null {
  const candidates = [
    process.env.JIRA_CONFIG_DIR
      ? path.join(process.env.JIRA_CONFIG_DIR, '.env')
      : null,
    path.join(os.homedir(), '.config', 'jira-automation', '.env'),
  ].filter((p): p is string => !!p);

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const env: Record<string, string> = {};
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
    }
    if (
      env.JIRA_URL &&
      env.JIRA_EMAIL &&
      env.JIRA_API_TOKEN &&
      env.JIRA_PROJECT_KEY
    ) {
      return {
        url: env.JIRA_URL.replace(/\/$/, ''),
        email: env.JIRA_EMAIL,
        token: env.JIRA_API_TOKEN,
        projectKey: env.JIRA_PROJECT_KEY,
      };
    }
  }
  return null;
}

interface JiraSearchResponse {
  issues?: Array<{
    key?: string;
    self?: string;
    fields?: {
      summary?: string;
      status?: { name?: string; statusCategory?: { name?: string } };
      issuetype?: { name?: string };
      assignee?: { displayName?: string } | null;
      parent?: {
        key?: string;
        fields?: { summary?: string };
      };
    };
  }>;
}

export interface FetchResult {
  ok: boolean;
  issues: JiraIssueCache[];
  error?: string;
}

export async function fetchOpenJiraIssues(): Promise<FetchResult> {
  const env = readJiraEnv();
  if (!env) {
    return { ok: false, issues: [], error: 'jira env not found' };
  }

  const jql = `project = ${env.projectKey} AND statusCategory != Done ORDER BY status ASC, updated DESC`;
  const params = new URLSearchParams({
    jql,
    maxResults: '100',
    fields: 'summary,status,issuetype,assignee,parent',
  });
  const apiUrl = `${env.url}/rest/api/3/search/jql?${params.toString()}`;

  const auth =
    'Basic ' + Buffer.from(`${env.email}:${env.token}`).toString('base64');

  try {
    const res = await fetch(apiUrl, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        issues: [],
        error: `HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }
    const data = (await res.json()) as JiraSearchResponse;
    const issues = (data.issues ?? []).map((i): JiraIssueCache => {
      const f = i.fields ?? {};
      return {
        key: i.key ?? '',
        summary: f.summary ?? '(no title)',
        status: f.status?.name ?? '?',
        statusCategory: f.status?.statusCategory?.name ?? '?',
        type: f.issuetype?.name ?? '?',
        assignee: f.assignee?.displayName ?? null,
        url: `${env.url}/browse/${i.key ?? ''}`,
        parentKey: f.parent?.key ?? null,
        parentSummary: f.parent?.fields?.summary ?? null,
      };
    });
    return { ok: true, issues };
  } catch (err) {
    logger.warn({ err }, 'jira fetch failed');
    return {
      ok: false,
      issues: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Find candidate Jira issue keys (e.g., S14P31D107-431) anywhere in text. */
export function extractJiraKeys(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[A-Z][A-Z0-9]+-\d+/g) ?? [];
  return Array.from(new Set(matches));
}

export interface TransitionResult {
  ok: boolean;
  appliedStatus?: string;
  error?: string;
}

/**
 * Map English status names to all known aliases (incl. Korean) so we can
 * match against Jira instances configured in any language. Order matters —
 * caller's input is normalized through this before fuzzy matching.
 */
const STATUS_ALIASES: Record<string, string[]> = {
  done: ['done', '완료', 'closed', 'resolved'],
  'in progress': ['in progress', '진행 중', '진행중', 'in-progress', 'doing'],
  'to do': ['to do', 'todo', 'to-do', '해야 할 일', '할 일', '할일', 'open'],
  'code review': ['code review', 'review', '코드 리뷰', '리뷰', 'reviewing'],
};

function statusAliases(input: string): string[] {
  const normalized = input.trim().toLowerCase();
  if (STATUS_ALIASES[normalized]) return STATUS_ALIASES[normalized];
  // Reverse lookup: if user passed a Korean status, find its English bucket
  for (const [, aliases] of Object.entries(STATUS_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === normalized)) return aliases;
  }
  return [normalized]; // fallback to raw
}

/** Move a Jira issue to the target status name. Tries all known aliases (en+ko). */
export async function transitionIssue(
  issueKey: string,
  targetStatus: string,
): Promise<TransitionResult> {
  const env = readJiraEnv();
  if (!env) return { ok: false, error: 'jira env not found' };

  const auth =
    'Basic ' + Buffer.from(`${env.email}:${env.token}`).toString('base64');

  try {
    const listUrl = `${env.url}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
    const listRes = await fetch(listUrl, {
      method: 'GET',
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!listRes.ok) {
      const t = await listRes.text().catch(() => '');
      return { ok: false, error: `list ${listRes.status}: ${t.slice(0, 200)}` };
    }
    const data = (await listRes.json()) as {
      transitions?: Array<{
        id?: string;
        name?: string;
        to?: { name?: string };
      }>;
    };
    const aliases = statusAliases(targetStatus);
    const transitions = data.transitions ?? [];
    // Match against any alias, case-insensitive partial match.
    const match = transitions.find((tr) => {
      const candidates = [tr.name, tr.to?.name]
        .filter(Boolean)
        .map((c) => (c as string).toLowerCase());
      return aliases.some((a) =>
        candidates.some((c) => c.includes(a) || a.includes(c)),
      );
    });
    if (!match || !match.id) {
      return {
        ok: false,
        error: `no transition matching "${targetStatus}". available: ${(data.transitions ?? []).map((t) => t.to?.name ?? t.name).join(', ')}`,
      };
    }

    // 2. Apply transition
    const applyUrl = `${env.url}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`;
    const applyRes = await fetch(applyUrl, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ transition: { id: match.id } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!applyRes.ok) {
      const t = await applyRes.text().catch(() => '');
      return {
        ok: false,
        error: `apply ${applyRes.status}: ${t.slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      appliedStatus: match.to?.name ?? match.name,
    };
  } catch (err) {
    logger.warn({ err, issueKey, targetStatus }, 'jira transition failed');
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface CreateResult {
  ok: boolean;
  key?: string;
  url?: string;
  error?: string;
}

/** Create a Task issue via Jira REST. */
export async function createJiraIssue(
  summary: string,
  issueType: 'Task' | 'Story' | 'Bug' = 'Task',
): Promise<CreateResult> {
  const env = readJiraEnv();
  if (!env) return { ok: false, error: 'jira env not found' };

  const auth =
    'Basic ' + Buffer.from(`${env.email}:${env.token}`).toString('base64');
  const apiUrl = `${env.url}/rest/api/3/issue`;

  const body = {
    fields: {
      project: { key: env.projectKey },
      summary,
      issuetype: { name: issueType },
    },
  };

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        error: `HTTP ${res.status}: ${text.slice(0, 300)}`,
      };
    }
    const data = (await res.json()) as { key?: string };
    const key = data.key ?? '';
    return {
      ok: true,
      key,
      url: `${env.url}/browse/${key}`,
    };
  } catch (err) {
    logger.warn({ err }, 'jira create failed');
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
