/**
 * HTTP API for synchronous agent request/response.
 *
 * Adds a `POST /api/agent-message` endpoint that enqueues a one-shot agent
 * invocation through GroupQueue and waits (up to timeoutMs) for the first
 * non-null streamed result. Used by the RTS game (and other realtime
 * clients) that need a request/response shape on top of Nanoclaw.
 *
 * Default OFF — enable with NANOCLAW_HTTP_ENABLED=1 and provide
 * NANOCLAW_HTTP_TOKEN. Coexists with the existing IPC/polling pipeline
 * without modification.
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { Server } from 'http';

import { ASSISTANT_NAME } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { isValidGroupFolder } from './group-folder.js';
import { AgentResponseRunner, GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 5 * 60_000;
export const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB body cap

export interface HttpServerOptions {
  /** Bearer token required on every request. */
  token: string;
  port: number;
  queue: GroupQueue;
  /**
   * Optional override for the runner used to invoke agents. Production
   * passes `defaultAgentRunner` (which spawns a real container); tests
   * inject a fake.
   */
  runner?: AgentResponseRunner;
}

export interface HttpServer {
  app: Express;
  server: Server | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentMessageRequestBody {
  groupFolder?: unknown;
  message?: unknown;
  timeoutMs?: unknown;
}

interface ParsedRequest {
  groupFolder: string;
  message: string;
  timeoutMs: number;
}

function parseBody(body: AgentMessageRequestBody): ParsedRequest | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object';

  const folder = body.groupFolder;
  if (typeof folder !== 'string' || !folder.trim()) {
    return 'groupFolder is required and must be a non-empty string';
  }
  if (!isValidGroupFolder(folder)) {
    return `Invalid groupFolder "${folder}"`;
  }

  const message = body.message;
  if (typeof message !== 'string' || !message.length) {
    return 'message is required and must be a non-empty string';
  }
  if (Buffer.byteLength(message, 'utf-8') > MAX_MESSAGE_BYTES) {
    return `message exceeds ${MAX_MESSAGE_BYTES} byte limit`;
  }

  let timeoutMs: number = DEFAULT_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    if (
      typeof body.timeoutMs !== 'number' ||
      !Number.isFinite(body.timeoutMs) ||
      body.timeoutMs <= 0
    ) {
      return 'timeoutMs must be a positive number';
    }
    timeoutMs = Math.min(Math.floor(body.timeoutMs), MAX_TIMEOUT_MS);
  }

  return { groupFolder: folder, message, timeoutMs };
}

function buildAuthMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const expected = `Bearer ${token}`;
    if (header !== expected) {
      res.status(401).json({ success: false, error: 'unauthorized' });
      return;
    }
    next();
  };
}

/**
 * Production runner: spawn a container via runContainerAgent and forward
 * each non-null streamed `result.result` chunk to onChunk. Stops as soon
 * as the request side resolves (closeStdin is called by the queue wrapper).
 */
export const defaultAgentRunner: AgentResponseRunner = async (
  groupFolder,
  message,
  ctx,
) => {
  const group: RegisteredGroup = {
    name: groupFolder,
    folder: groupFolder,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };

  await runContainerAgent(
    group,
    {
      prompt: message,
      groupFolder,
      chatJid: `http:${groupFolder}`,
      isMain: false,
      assistantName: ASSISTANT_NAME,
    },
    () => {
      // We don't need to register the process anywhere — the queue wrapper
      // already owns the JID-level lifecycle (closeStdin, etc.).
    },
    async (output) => {
      if (ctx.signal.aborted) return;
      if (output.status === 'error') {
        // Propagate by throwing — the queue wrapper rejects the Promise.
        throw new Error(output.error || 'agent error');
      }
      if (output.result) {
        const text =
          typeof output.result === 'string'
            ? output.result
            : JSON.stringify(output.result);
        if (text.trim()) ctx.onChunk(text);
      }
    },
  );
};

export function createHttpServer(opts: HttpServerOptions): HttpServer {
  if (!opts.token) {
    throw new Error('createHttpServer requires a non-empty token');
  }

  const runner: AgentResponseRunner = opts.runner ?? defaultAgentRunner;

  const app = express();
  app.use(express.json({ limit: MAX_MESSAGE_BYTES + 64 * 1024 }));
  app.use(buildAuthMiddleware(opts.token));

  app.post(
    '/api/agent-message',
    (req: Request, res: Response, next: NextFunction) => {
      const parsed = parseBody(req.body as AgentMessageRequestBody);
      if (typeof parsed === 'string') {
        res.status(400).json({ success: false, error: parsed });
        return;
      }
      opts.queue
        .enqueueWithResponse(
          parsed.groupFolder,
          parsed.message,
          parsed.timeoutMs,
          runner,
        )
        .then((output) => {
          res.status(200).json({ success: true, output });
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          const status = /timed out/i.test(msg) ? 504 : 500;
          logger.warn(
            { err: msg, group: parsed.groupFolder },
            'agent-message request failed',
          );
          res.status(status).json({ success: false, error: msg });
        })
        .catch(next);
    },
  );

  // Generic JSON error handler so uncaught errors still return JSON.
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'http-server unhandled error');
      if (res.headersSent) return;
      res.status(500).json({ success: false, error: msg });
    },
  );

  let server: Server | null = null;

  return {
    app,
    get server() {
      return server;
    },
    async start(): Promise<void> {
      if (server) return;
      await new Promise<void>((resolve, reject) => {
        const s = app.listen(opts.port, () => resolve());
        s.on('error', reject);
        server = s;
      });
      logger.info(
        { port: opts.port },
        'HTTP API listening for synchronous agent requests',
      );
    },
    async stop(): Promise<void> {
      const s = server;
      if (!s) return;
      server = null;
      await new Promise<void>((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
