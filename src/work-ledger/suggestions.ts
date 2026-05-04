import { extractJiraKeys } from './jira-fetcher.js';
import { JiraSuggestion, loadState, nextId, saveState } from './state.js';

export interface GitlabPushPayloadLite {
  ref?: string;
  user_name?: string;
  user_username?: string;
  commits?: Array<{
    id?: string;
    title?: string;
    message?: string;
  }>;
}

export interface GitlabMRPayloadLite {
  user?: { name?: string; username?: string };
  object_attributes?: {
    iid?: number;
    title?: string;
    description?: string;
    action?: string;
    state?: string;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    last_commit?: { id?: string; message?: string };
  };
}

/** Build suggestion candidates from a GitLab Push event. */
export function buildSuggestionsFromPush(
  p: GitlabPushPayloadLite,
): JiraSuggestion[] {
  const ref = p.ref ?? '';
  if (!/refs\/heads\/(dev|develop)$/.test(ref)) return [];
  const branch = ref.replace(/^refs\/heads\//, '');
  const who = p.user_name ?? p.user_username ?? '';
  const out: JiraSuggestion[] = [];
  const seen = new Set<string>();

  for (const c of p.commits ?? []) {
    const text = `${c.title ?? ''}\n${c.message ?? ''}`;
    const keys = extractJiraKeys(text);
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: nextId('sugg'),
        source: 'push',
        triggerRef: branch,
        candidateIssueKey: key,
        confidence: 0.9, // explicit issue key in commit message
        action: { kind: 'transition', status: 'Done' },
        reasoning: `${branch} 푸시 커밋 \`${(c.id ?? '').slice(0, 7)}\` 메시지에 \`${key}\` 명시 (by ${who})`,
        createdAt: new Date().toISOString(),
      });
    }
  }
  return out;
}

/** Build suggestion candidate from a GitLab Merge Request event. */
export function buildSuggestionFromMR(
  p: GitlabMRPayloadLite,
): JiraSuggestion | null {
  const a = p.object_attributes ?? {};
  const target = a.target_branch ?? '';
  if (target !== 'dev' && target !== 'develop') return null;
  const action = a.action ?? '';
  if (action !== 'merge' && action !== 'open' && action !== 'reopen')
    return null;

  const src = a.source_branch ?? '';
  const title = a.title ?? '';
  const desc = a.description ?? '';
  const lastMsg = a.last_commit?.message ?? '';
  const who = p.user?.name ?? p.user?.username ?? '';

  // Try explicit Jira key in (title, last commit, branch, description)
  const candidates = extractJiraKeys(`${title}\n${lastMsg}\n${src}\n${desc}`);
  const key = candidates[0] ?? null;
  const targetStatus = action === 'merge' ? 'Done' : 'In Progress';
  const verb =
    action === 'merge' ? '머지' : action === 'open' ? '열림' : '재오픈';

  let confidence = 0;
  let reasoning = '';
  if (key) {
    confidence = action === 'merge' ? 0.95 : 0.85;
    reasoning = `MR !${a.iid ?? '?'} ${verb} (${src} → ${target}) — 명시 키 \`${key}\`. 제목: "${title.slice(0, 80)}" by ${who}`;
  } else {
    confidence = 0.4;
    reasoning = `MR !${a.iid ?? '?'} ${verb} (${src} → ${target}) — 명시 키 없음. 브랜치/제목 기반 추정 필요. 제목: "${title.slice(0, 80)}" by ${who}`;
  }

  return {
    id: nextId('sugg'),
    source: 'mr_merged',
    triggerRef: src,
    candidateIssueKey: key ?? undefined,
    confidence,
    action: { kind: 'transition', status: targetStatus },
    reasoning,
    createdAt: new Date().toISOString(),
  };
}

/** Append + dedupe (same source+triggerRef+key+action collapses to one). */
export function appendSuggestions(newOnes: JiraSuggestion[]): JiraSuggestion[] {
  const state = loadState();
  const dedup = new Map<string, JiraSuggestion>();
  for (const s of state.suggestions) {
    const k = `${s.source}|${s.triggerRef ?? ''}|${s.candidateIssueKey ?? ''}|${s.action.kind === 'transition' ? s.action.status : 'create'}`;
    dedup.set(k, s);
  }
  const added: JiraSuggestion[] = [];
  for (const s of newOnes) {
    const k = `${s.source}|${s.triggerRef ?? ''}|${s.candidateIssueKey ?? ''}|${s.action.kind === 'transition' ? s.action.status : 'create'}`;
    if (!dedup.has(k)) {
      dedup.set(k, s);
      added.push(s);
    }
  }
  state.suggestions = Array.from(dedup.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  saveState(state);
  return added;
}
