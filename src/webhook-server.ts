import http from 'node:http';
import crypto from 'node:crypto';

import { storeChatMetadata, storeMessage } from './db.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

export interface WebhookServerOpts {
  port: number;
  token: string;
  grafanaJid: string;
  grafanaChatName: string;
  /** Optional: GitLab webhook receiver. */
  gitlabJid?: string;
  gitlabChatName?: string;
  gitlabSecret?: string;
  /**
   * Optional: server-side handler for GitLab events. When set, GitLab
   * webhook payloads are passed to this callback (parse + persist
   * suggestions + refresh pin) and **no synthetic chat message is stored**
   * — the bot is not woken up. When unset, falls back to the legacy
   * synthetic-message path so debugging still surfaces unhandled events.
   */
  onGitlabEvent?: (
    payload: unknown,
    eventHeader: string,
  ) => Promise<{ summary: string }>;
  /** Prepended to synthetic alert content so it passes the message-loop trigger gate. */
  triggerPrefix: string;
}

const MAX_BODY_BYTES = 256 * 1024;

export function startWebhookServer(opts: WebhookServerOpts): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res, opts).catch((err) => {
      logger.error({ err }, 'Webhook handler crashed');
      try {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('internal error');
        }
      } catch {
        /* response already closed */
      }
    });
  });
  server.listen(opts.port, '0.0.0.0', () => {
    logger.info({ port: opts.port }, 'Webhook server listening');
  });
  return server;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: WebhookServerOpts,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('method not allowed');
    return;
  }
  const url = new URL(req.url ?? '', 'http://x');
  const isGitlab = url.pathname === '/gitlab-webhook';
  const isGrafana = url.pathname === '/grafana-alert';
  if (!isGitlab && !isGrafana) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  if (isGrafana) {
    const provided = url.searchParams.get('token') ?? '';
    if (!constantTimeEquals(provided, opts.token)) {
      res.writeHead(401);
      res.end('unauthorized');
      logger.warn(
        { remote: req.socket.remoteAddress, path: url.pathname },
        'Webhook auth rejected',
      );
      return;
    }
  } else if (isGitlab) {
    if (!opts.gitlabJid || !opts.gitlabSecret) {
      res.writeHead(503);
      res.end('gitlab webhook not configured');
      return;
    }
    const queryToken = url.searchParams.get('token') ?? '';
    const headerToken =
      typeof req.headers['x-gitlab-token'] === 'string'
        ? (req.headers['x-gitlab-token'] as string)
        : '';
    const presented = headerToken || queryToken;
    if (!constantTimeEquals(presented, opts.gitlabSecret)) {
      res.writeHead(401);
      res.end('unauthorized');
      logger.warn(
        { remote: req.socket.remoteAddress, path: url.pathname },
        'GitLab webhook auth rejected',
      );
      return;
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      res.writeHead(413);
      res.end('payload too large');
      return;
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    res.writeHead(400);
    res.end('invalid json');
    return;
  }

  const now = new Date().toISOString();
  let targetJid: string;
  let chatName: string;
  let text: string;
  let sender: string;
  let senderName: string;
  let idPrefix: string;
  let logExtra: Record<string, unknown>;

  if (isGitlab) {
    const eventHeader =
      typeof req.headers['x-gitlab-event'] === 'string'
        ? (req.headers['x-gitlab-event'] as string)
        : '';
    // Preferred path: server-side handler builds suggestions silently.
    if (opts.onGitlabEvent) {
      try {
        const result = await opts.onGitlabEvent(payload, eventHeader);
        logger.info(
          { event: eventHeader, summary: result.summary },
          'GitLab webhook handled server-side',
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, summary: result.summary }));
        return;
      } catch (err) {
        logger.error(
          { err, event: eventHeader },
          'GitLab handler crashed — falling back to chat',
        );
        // fall through to legacy chat-message path
      }
    }
    const formatted = formatGitlabEvent(payload, eventHeader);
    if (!formatted) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skipped: true }));
      return;
    }
    targetJid = opts.gitlabJid as string;
    chatName = opts.gitlabChatName ?? 'GitLab';
    text = formatted;
    sender = 'gitlab-webhook';
    senderName = 'GitLab';
    idPrefix = 'gitlab-event';
    logExtra = { event: eventHeader };
  } else {
    targetJid = opts.grafanaJid;
    chatName = opts.grafanaChatName;
    text = formatGrafanaAlert(payload);
    sender = 'grafana-webhook';
    senderName = 'Grafana';
    idPrefix = 'grafana-alert';
    logExtra = { status: extractStatus(payload) };
  }

  storeChatMetadata(targetJid, now, chatName, 'discord', true);

  // Prepend the bot trigger so this synthetic message passes the message-loop
  // trigger gate (the channel is set to requires_trigger=1 to silence the bot
  // on user chitchat). is_from_me=true lets it bypass the sender allowlist.
  const triggered = `${opts.triggerPrefix} ${text}`;
  const msg: NewMessage = {
    id: `${idPrefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    chat_jid: targetJid,
    sender,
    sender_name: senderName,
    content: triggered,
    timestamp: now,
    is_from_me: true,
    is_bot_message: false,
  };
  storeMessage(msg);
  logger.info(
    { jid: targetJid, msgId: msg.id, ...logExtra },
    'Webhook stored event',
  );

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, id: msg.id }));
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface GrafanaAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  valueString?: string;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
}

interface GrafanaAlertPayload {
  status?: string;
  alerts?: GrafanaAlert[];
}

function extractStatus(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const p = payload as GrafanaAlertPayload;
    return p.status ?? 'unknown';
  }
  return 'unknown';
}

interface GitlabPushPayload {
  object_kind?: string;
  ref?: string;
  before?: string;
  after?: string;
  user_name?: string;
  user_username?: string;
  project?: { name?: string; web_url?: string };
  commits?: Array<{
    id?: string;
    message?: string;
    title?: string;
    url?: string;
    author?: { name?: string };
  }>;
  total_commits_count?: number;
}

interface GitlabMRPayload {
  object_kind?: string;
  user?: { name?: string; username?: string };
  project?: { name?: string; web_url?: string };
  object_attributes?: {
    iid?: number;
    title?: string;
    state?: string;
    action?: string;
    source_branch?: string;
    target_branch?: string;
    url?: string;
    last_commit?: { id?: string; message?: string };
    merge_commit_sha?: string;
  };
}

const DEV_BRANCH_REFS = new Set(['refs/heads/dev', 'refs/heads/develop']);

function formatGitlabEvent(
  payload: unknown,
  eventHeader: string,
): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const kind =
    (payload as { object_kind?: string }).object_kind ??
    (eventHeader || '').toLowerCase().replace(/ hook$/, '');

  if (kind === 'push' || eventHeader === 'Push Hook') {
    return formatGitlabPush(payload as GitlabPushPayload);
  }
  if (kind === 'merge_request' || eventHeader === 'Merge Request Hook') {
    return formatGitlabMR(payload as GitlabMRPayload);
  }
  // Unknown event — silently skip (return null = caller acks but doesn't post).
  return null;
}

function formatGitlabPush(p: GitlabPushPayload): string | null {
  const ref = p.ref ?? '';
  if (!DEV_BRANCH_REFS.has(ref)) return null; // only dev branch matters
  const commits = Array.isArray(p.commits) ? p.commits : [];
  if (commits.length === 0) return null;

  const branch = ref.replace(/^refs\/heads\//, '');
  const proj = p.project?.name ?? '?';
  const who = p.user_name ?? p.user_username ?? '?';
  const lines: string[] = [];
  lines.push(
    `**GitLab Push** — \`${proj}\` / \`${branch}\` (${commits.length}커밋, by ${who})`,
  );
  lines.push('');
  for (const c of commits.slice(0, 10)) {
    const sha = (c.id ?? '').slice(0, 7);
    const title = (c.title ?? c.message ?? '').split('\n')[0].trim();
    const author = c.author?.name ?? '';
    lines.push(`- \`${sha}\` ${title}${author ? ` _(${author})_` : ''}`);
  }
  if (commits.length > 10) lines.push(`- … +${commits.length - 10} more`);
  lines.push('');
  lines.push(
    `이 커밋들 dev 브랜치에 들어왔다. 머지 커밋이면 어떤 브랜치/이슈에서 왔는지 파악하고, 매칭되는 Jira 이슈가 있으면 후보를 사용자에게 보고해라 (자동 액션 X — 매칭 후보만 알려라).`,
  );
  return lines.join('\n');
}

function formatGitlabMR(p: GitlabMRPayload): string | null {
  const a = p.object_attributes ?? {};
  const target = a.target_branch ?? '';
  if (target !== 'dev' && target !== 'develop') return null;
  const action = a.action ?? '';
  const state = a.state ?? '';
  // Only care about merged or open transitions
  if (action !== 'merge' && action !== 'open' && action !== 'reopen')
    return null;

  const proj = p.project?.name ?? '?';
  const iid = a.iid ?? '?';
  const title = a.title ?? '(no title)';
  const src = a.source_branch ?? '?';
  const who = p.user?.name ?? p.user?.username ?? '?';
  const url = a.url ?? '';

  const verb =
    action === 'merge' ? '머지됨' : action === 'open' ? '열림' : '재오픈';
  const lines: string[] = [];
  lines.push(`**GitLab MR ${verb}** — \`${proj}\` !${iid}: ${title}`);
  lines.push(
    `- 브랜치: \`${src}\` → \`${target}\` (state: ${state}, by ${who})`,
  );
  if (url) lines.push(`- 링크: ${url}`);
  if (action === 'merge') {
    lines.push('');
    lines.push(
      `이 MR이 dev 에 머지됐다. 브랜치명/타이틀에서 매칭되는 Jira 이슈를 추정하고, 후보가 있으면 "PROJ-?? 를 \`Code Review → Done\`으로 옮길까?" 형태로 사용자에게 확인 요청해라. 자동 전이 X.`,
    );
  } else {
    lines.push('');
    lines.push(
      `MR 새로 ${verb}. 매칭되는 Jira 이슈를 \`In Progress\`로 옮겨야 할지 사용자한테 한 줄로 묻기만 해라.`,
    );
  }
  return lines.join('\n');
}

function formatGrafanaAlert(payload: unknown): string {
  const p =
    payload && typeof payload === 'object'
      ? (payload as GrafanaAlertPayload)
      : ({} as GrafanaAlertPayload);
  const status = p.status ?? 'unknown';
  const alerts = Array.isArray(p.alerts) ? p.alerts : [];
  const isResolved = status.toLowerCase() === 'resolved';

  if (alerts.length === 0) {
    return `**Grafana Webhook** (status: ${status})\n\n_payload에 alerts 없음_`;
  }

  const lines: string[] = [];
  lines.push(
    `**Grafana 알림 ${isResolved ? '해소' : '발화'}** — ${alerts.length}건 (status: ${status})`,
  );

  for (const a of alerts) {
    const name = a.labels?.alertname ?? '(unnamed)';
    const aStatus = a.status ?? status;
    lines.push('');
    lines.push(`### ${name} \`${aStatus}\``);
    if (a.annotations?.summary) lines.push(`- 요약: ${a.annotations.summary}`);
    if (a.annotations?.description)
      lines.push(`- 상세: ${a.annotations.description}`);
    if (a.valueString) lines.push(`- 값: ${a.valueString}`);
    if (a.startsAt) lines.push(`- 시작: ${a.startsAt}`);
    if (a.endsAt && !a.endsAt.startsWith('0001-01-01'))
      lines.push(`- 종료: ${a.endsAt}`);
    const labelPairs = Object.entries(a.labels ?? {})
      .filter(([k]) => k !== 'alertname')
      .map(([k, v]) => `\`${k}=${v}\``)
      .join(' ');
    if (labelPairs) lines.push(`- 라벨: ${labelPairs}`);
    if (a.generatorURL) lines.push(`- 링크: ${a.generatorURL}`);
  }

  lines.push('');
  lines.push(
    isResolved
      ? '알람이 해소됐다. 짧게 확인 메시지만 보내라.'
      : '이 알람의 원인 추정 + 영향 범위 + 권장 대응을 한국어로 간결히 보고해라.',
  );

  return lines.join('\n');
}
