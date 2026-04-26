import http from 'http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GroupQueue } from './group-queue.js';
import {
  createHttpServer,
  HttpServer,
  type AgentMessageRequestBody,
} from './http-server.js';
import type { AgentResponseRunner } from './group-queue.js';

const TOKEN = 'test-token';

interface JsonResponse {
  status: number;
  body: { success: boolean; output?: string; error?: string };
}

async function postJson(
  port: number,
  body: AgentMessageRequestBody,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port,
        path: '/api/agent-message',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          authorization: `Bearer ${TOKEN}`,
          ...headers,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: chunks ? JSON.parse(chunks) : {},
            });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

interface Harness {
  server: HttpServer;
  port: number;
  queue: GroupQueue;
}

async function startHarness(runner: AgentResponseRunner): Promise<Harness> {
  const queue = new GroupQueue();
  // Port 0 → OS assigns a free ephemeral port; we read it back from app.server.
  const server = createHttpServer({ token: TOKEN, port: 0, queue, runner });
  await server.start();
  // After start(), the underlying http.Server is bound; pull the actual port.
  const addr = server.server!.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('expected AddressInfo');
  }
  return { server, port: addr.port, queue };
}

describe('HTTP server — POST /api/agent-message', () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    harness = null;
  });

  afterEach(async () => {
    if (harness) {
      await harness.queue.shutdown(0);
      await harness.server.stop();
      harness = null;
    }
  });

  it('returns 200 with the agent output on success', async () => {
    const runner: AgentResponseRunner = async (_folder, _msg, ctx) => {
      ctx.onChunk('[{"type":"move","unitIds":[1],"target":{"x":10,"y":10}}]');
    };
    harness = await startHarness(runner);

    const res = await postJson(harness.port, {
      groupFolder: 'rts-ai',
      message: 'tick=1',
      timeoutMs: 5_000,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.output).toContain('"type":"move"');
  });

  it('returns 401 when Authorization header is missing', async () => {
    harness = await startHarness(async (_f, _m, ctx) => ctx.onChunk('ok'));

    const res = await postJson(
      harness.port,
      { groupFolder: 'rts-ai', message: 'hi' },
      { authorization: '' },
    );

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 when Bearer token is wrong', async () => {
    harness = await startHarness(async (_f, _m, ctx) => ctx.onChunk('ok'));

    const res = await postJson(
      harness.port,
      { groupFolder: 'rts-ai', message: 'hi' },
      { authorization: 'Bearer wrong-token' },
    );

    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid groupFolder (path traversal)', async () => {
    harness = await startHarness(async (_f, _m, ctx) => ctx.onChunk('ok'));

    const res = await postJson(harness.port, {
      groupFolder: '../etc',
      message: 'hi',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid groupfolder/i);
  });

  it('returns 400 for missing message', async () => {
    harness = await startHarness(async (_f, _m, ctx) => ctx.onChunk('ok'));
    const res = await postJson(harness.port, { groupFolder: 'rts-ai' });
    expect(res.status).toBe(400);
  });

  it('returns 504 when the agent does not respond within timeoutMs', async () => {
    const runner: AgentResponseRunner = async (_f, _m, ctx) => {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };
    harness = await startHarness(runner);

    const res = await postJson(harness.port, {
      groupFolder: 'rts-ai',
      message: 'tick=1',
      timeoutMs: 50,
    });

    expect(res.status).toBe(504);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it('serializes concurrent same-group requests through the queue', async () => {
    let active = 0;
    let maxActive = 0;
    let counter = 0;

    const runner: AgentResponseRunner = async (_f, _m, ctx) => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Yield once so other queued tasks would race if concurrency allowed.
      await new Promise((resolve) => setTimeout(resolve, 5));
      ctx.onChunk(`output-${++counter}`);
      active--;
    };
    harness = await startHarness(runner);

    const requests = Array.from({ length: 5 }, () =>
      postJson(harness!.port, {
        groupFolder: 'rts-ai',
        message: 'tick',
        timeoutMs: 5_000,
      }),
    );
    const results = await Promise.all(requests);

    for (const r of results) expect(r.status).toBe(200);
    expect(maxActive).toBe(1);
    const outputs = results.map((r) => r.body.output);
    expect(new Set(outputs).size).toBe(5); // all unique → ran in turn
  });

  it('returns 500 when the runner throws', async () => {
    const runner: AgentResponseRunner = async () => {
      throw new Error('agent crashed');
    };
    harness = await startHarness(runner);

    const res = await postJson(harness.port, {
      groupFolder: 'rts-ai',
      message: 'tick',
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/agent crashed/);
  });
});
