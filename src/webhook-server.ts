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
  if (url.pathname !== '/grafana-alert') {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const provided = url.searchParams.get('token') ?? '';
  if (!constantTimeEquals(provided, opts.token)) {
    res.writeHead(401);
    res.end('unauthorized');
    logger.warn({ remote: req.socket.remoteAddress }, 'Webhook auth rejected');
    return;
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

  const text = formatGrafanaAlert(payload);
  const now = new Date().toISOString();
  storeChatMetadata(
    opts.grafanaJid,
    now,
    opts.grafanaChatName,
    'discord',
    true,
  );

  // Prepend the bot trigger so this synthetic message passes the message-loop
  // trigger gate (the channel is set to requires_trigger=1 to silence the bot
  // on user chitchat). is_from_me=true lets it bypass the sender allowlist.
  const triggered = `${opts.triggerPrefix} ${text}`;
  const msg: NewMessage = {
    id: `grafana-alert-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    chat_jid: opts.grafanaJid,
    sender: 'grafana-webhook',
    sender_name: 'Grafana',
    content: triggered,
    timestamp: now,
    is_from_me: true,
    is_bot_message: false,
  };
  storeMessage(msg);
  logger.info(
    { jid: opts.grafanaJid, msgId: msg.id, status: extractStatus(payload) },
    'Webhook stored grafana alert',
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
