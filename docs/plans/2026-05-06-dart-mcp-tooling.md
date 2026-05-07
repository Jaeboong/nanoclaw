# DART MCP Tooling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give NanoClaw agents a reusable OpenDART toolset exposed as both a CLI and MCP tools, with secrets injected from host env instead of hardcoded scripts.

**Architecture:** Implement DART as a module in the agent container: a shared TypeScript client, `dart-tool` CLI, and `dart` MCP stdio server. Add a generic host-side `containerConfig.envVars` passthrough so only selected groups receive `DART_API_KEY`; keep keys, company lists, Notion pages, and job artifacts in ignored instance areas.

**Tech Stack:** Node.js 22, TypeScript ESM, built-in `fetch`, `@modelcontextprotocol/sdk`, `zod`, Vitest, Docker.

---

## Boundary Rules

- **Module:** DART client, CLI, MCP server, container skill docs.
- **Core:** generic container env-var passthrough by allowlisted variable name.
- **Instance:** `DART_API_KEY`, job channel registration, Notion page IDs, company-specific outputs, migrated `/workspace/extra/job` scripts.
- **Never commit:** real API keys, channel IDs, Notion page IDs, local host paths outside generic examples, generated company artifacts.

## Task 1: Add Generic Container Env Passthrough

**Files:**
- Modify: `src/types.ts`
- Create: `src/env-passthrough.ts`
- Create: `src/env-passthrough.test.ts`
- Modify: `src/container-runner.ts`
- Modify: `scripts/dev-shell.sh`

**Step 1: Write env passthrough tests**

Create `src/env-passthrough.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveContainerEnv } from './env-passthrough.js';

describe('resolveContainerEnv', () => {
  it('passes only valid requested names with available values', () => {
    expect(
      resolveContainerEnv(['DART_API_KEY', 'missing', 'bad-name'], {
        DART_API_KEY: 'secret',
      }),
    ).toEqual([{ name: 'DART_API_KEY', value: 'secret' }]);
  });

  it('deduplicates names and preserves first valid order', () => {
    expect(
      resolveContainerEnv(['DART_API_KEY', 'DART_API_KEY', 'OPENAI_API_KEY'], {
        DART_API_KEY: 'a',
        OPENAI_API_KEY: 'b',
      }),
    ).toEqual([
      { name: 'DART_API_KEY', value: 'a' },
      { name: 'OPENAI_API_KEY', value: 'b' },
    ]);
  });
});
```

**Step 2: Run failing test**

Run:

```bash
npm test -- src/env-passthrough.test.ts
```

Expected: FAIL because `src/env-passthrough.ts` does not exist.

**Step 3: Add type and resolver**

Modify `src/types.ts`:

```ts
export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  envVars?: string[];
  timeout?: number;
}
```

Create `src/env-passthrough.ts`:

```ts
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface ResolvedContainerEnv {
  name: string;
  value: string;
}

export function resolveContainerEnv(
  names: string[] | undefined,
  source: Record<string, string | undefined>,
): ResolvedContainerEnv[] {
  const out: ResolvedContainerEnv[] = [];
  const seen = new Set<string>();
  for (const raw of names ?? []) {
    const name = raw.trim();
    if (!ENV_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    const value = source[name];
    if (value) out.push({ name, value });
  }
  return out;
}
```

**Step 4: Pass env vars to Docker**

Modify `src/container-runner.ts`:

- Import `readEnvFile` and `resolveContainerEnv`.
- Read requested names from `group.containerConfig?.envVars`.
- Resolve values from `process.env` plus `.env`.
- Add `-e NAME=value` to Docker args before mounts.
- Log only env var names, never values.

Implementation shape:

```ts
const requestedEnvVars = group.containerConfig?.envVars ?? [];
const envFileValues = readEnvFile(requestedEnvVars);
const resolvedEnv = resolveContainerEnv(requestedEnvVars, {
  ...envFileValues,
  ...process.env,
});
for (const entry of resolvedEnv) {
  args.push('-e', `${entry.name}=${entry.value}`);
}
```

Adjust `buildContainerArgs(...)` signature if needed so it receives the group or resolved env entries.

**Step 5: Mirror env passthrough in dev shell**

Modify `scripts/dev-shell.sh` so local container debugging matches production:

```bash
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  value="${!name:-}"
  [[ -n "$value" ]] && ARGS+=(-e "$name=$value")
done < <(node -e "
  const cfg = JSON.parse(process.argv[1]).container_config;
  if (!cfg) process.exit(0);
  const parsed = JSON.parse(cfg);
  for (const name of parsed.envVars || []) console.log(name);
" "$GROUP_JSON")
```

**Step 6: Verify**

Run:

```bash
npm test -- src/env-passthrough.test.ts
npm run typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/types.ts src/env-passthrough.ts src/env-passthrough.test.ts src/container-runner.ts scripts/dev-shell.sh
git commit -m "feat(core): allow group-scoped container env passthrough"
```

## Task 2: Add Shared OpenDART Client

**Files:**
- Create: `container/agent-runner/src/dart/types.ts`
- Create: `container/agent-runner/src/dart/client.ts`
- Create: `container/agent-runner/src/dart/client.test.ts`
- Modify: `vitest.config.ts`

**Step 1: Include container tests**

Modify `vitest.config.ts`:

```ts
export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'container/agent-runner/src/**/*.test.ts',
    ],
  },
});
```

**Step 2: Write client tests with mocked fetch**

Create `container/agent-runner/src/dart/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenDartClient } from './client.js';

afterEach(() => vi.restoreAllMocks());

describe('OpenDartClient', () => {
  it('adds crtfc_key and returns JSON payloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: '000', list: [] }),
      text: async () => '',
    });
    const client = new OpenDartClient({ apiKey: 'key', fetchImpl: fetchMock });
    await client.listFilings({ corpCode: '00149293', bgnDe: '20260101' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('crtfc_key')).toBe('key');
    expect(url.pathname).toBe('/api/list.json');
  });

  it('throws on OpenDART non-success status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: '013', message: 'no data' }),
      text: async () => '',
    });
    const client = new OpenDartClient({ apiKey: 'key', fetchImpl: fetchMock });
    await expect(client.companyInfo('00149293')).rejects.toThrow('013');
  });
});
```

**Step 3: Run failing tests**

Run:

```bash
npm test -- container/agent-runner/src/dart/client.test.ts
```

Expected: FAIL because client files do not exist.

**Step 4: Implement client**

Create `container/agent-runner/src/dart/types.ts` with minimal JSON-safe types:

```ts
export type JsonObject = Record<string, unknown>;

export interface DartClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ListFilingsInput {
  corpCode?: string;
  bgnDe?: string;
  endDe?: string;
  lastReprtAt?: 'Y' | 'N';
  pblntfTy?: string;
  pblntfDetailTy?: string;
  corpCls?: string;
  sort?: 'date' | 'crp' | 'rpt';
  sortMth?: 'asc' | 'desc';
  pageNo?: number;
  pageCount?: number;
}
```

Create `container/agent-runner/src/dart/client.ts`:

```ts
import { DartClientOptions, JsonObject, ListFilingsInput } from './types.js';

export class DartApiError extends Error {
  constructor(
    public readonly status: string,
    public readonly message: string,
  ) {
    super(`OpenDART ${status}: ${message}`);
  }
}

export class OpenDartClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DartClientOptions) {
    if (!options.apiKey) throw new Error('DART_API_KEY is required');
    this.baseUrl = options.baseUrl ?? 'https://opendart.fss.or.kr/api';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async requestJson(endpoint: string, params: Record<string, string | number | undefined>): Promise<JsonObject> {
    const url = new URL(`${this.baseUrl}/${endpoint}`);
    url.searchParams.set('crtfc_key', this.options.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    const response = await this.fetchImpl(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${endpoint}`);
    const data = (await response.json()) as JsonObject;
    const status = typeof data.status === 'string' ? data.status : undefined;
    if (status && status !== '000') {
      throw new DartApiError(status, String(data.message ?? 'OpenDART error'));
    }
    return data;
  }

  listFilings(input: ListFilingsInput): Promise<JsonObject> {
    return this.requestJson('list.json', {
      corp_code: input.corpCode,
      bgn_de: input.bgnDe,
      end_de: input.endDe,
      last_reprt_at: input.lastReprtAt,
      pblntf_ty: input.pblntfTy,
      pblntf_detail_ty: input.pblntfDetailTy,
      corp_cls: input.corpCls,
      sort: input.sort,
      sort_mth: input.sortMth,
      page_no: input.pageNo,
      page_count: input.pageCount,
    });
  }

  companyInfo(corpCode: string): Promise<JsonObject> {
    return this.requestJson('company.json', { corp_code: corpCode });
  }

  singleFinancialStatement(corpCode: string, bsnsYear: string, reprtCode: string): Promise<JsonObject> {
    return this.requestJson('fnlttSinglAcntAll.json', {
      corp_code: corpCode,
      bsns_year: bsnsYear,
      reprt_code: reprtCode,
    });
  }
}
```

**Step 5: Verify**

Run:

```bash
npm test -- container/agent-runner/src/dart/client.test.ts
npm --prefix container/agent-runner run build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add vitest.config.ts container/agent-runner/src/dart
git commit -m "feat(dart): add shared OpenDART client"
```

## Task 3: Add `dart-tool` CLI

**Files:**
- Create: `container/agent-runner/src/dart-cli.ts`
- Modify: `container/Dockerfile`
- Create: `container/skills/dart/SKILL.md`

**Step 1: Add CLI entrypoint**

Create `container/agent-runner/src/dart-cli.ts`:

```ts
import { OpenDartClient } from './dart/client.js';

function usage(): never {
  console.error(`usage:
  dart-tool company <corp_code>
  dart-tool filings --corp-code <corp_code> --from YYYYMMDD [--to YYYYMMDD]
  dart-tool financials --corp-code <corp_code> --year YYYY --report 11011
`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

const apiKey = process.env.DART_API_KEY;
if (!apiKey) {
  console.error('DART_API_KEY is not set');
  process.exit(2);
}

const client = new OpenDartClient({ apiKey });
const cmd = process.argv[2];

try {
  let out: unknown;
  if (cmd === 'company') {
    const corpCode = process.argv[3] ?? usage();
    out = await client.companyInfo(corpCode);
  } else if (cmd === 'filings') {
    out = await client.listFilings({
      corpCode: arg('--corp-code'),
      bgnDe: arg('--from'),
      endDe: arg('--to'),
      pageCount: Number(arg('--page-count') ?? 10),
    });
  } else if (cmd === 'financials') {
    out = await client.singleFinancialStatement(
      arg('--corp-code') ?? usage(),
      arg('--year') ?? usage(),
      arg('--report') ?? usage(),
    );
  } else {
    usage();
  }
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
```

**Step 2: Add Docker wrapper**

Modify `container/Dockerfile` after `RUN npm run build`:

```dockerfile
RUN printf '#!/bin/sh\nexec node /app/dist/dart-cli.js "$@"\n' > /usr/local/bin/dart-tool \
    && chmod +x /usr/local/bin/dart-tool
```

**Step 3: Add container skill instructions**

Create `container/skills/dart/SKILL.md`:

```md
---
name: dart
description: Use OpenDART company disclosure data from the container via dart-tool CLI or mcp__dart__* tools.
---

# DART

Use this for Korean company disclosure research. Prefer MCP tools when available; otherwise use `dart-tool`.

Required env: `DART_API_KEY`.

Examples:

```bash
dart-tool company 00149293
dart-tool filings --corp-code 00149293 --from 20260101 --page-count 10
dart-tool financials --corp-code 00149293 --year 2025 --report 11011
```

Write derived research under `/workspace/extra/job/<company>/` when the group has that mount.
Never print or store the API key.
```

**Step 4: Verify**

Run:

```bash
npm --prefix container/agent-runner run build
./container/build.sh
```

Expected: build succeeds and image includes `dart-tool`.

**Step 5: Commit**

```bash
git add container/agent-runner/src/dart-cli.ts container/Dockerfile container/skills/dart/SKILL.md
git commit -m "feat(dart): expose OpenDART CLI in agent container"
```

## Task 4: Add DART MCP Server

**Files:**
- Create: `container/agent-runner/src/dart-mcp-stdio.ts`
- Modify: `container/agent-runner/src/index.ts`
- Modify: `container/skills/capabilities/SKILL.md`

**Step 1: Create MCP stdio server**

Create `container/agent-runner/src/dart-mcp-stdio.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OpenDartClient } from './dart/client.js';

const apiKey = process.env.DART_API_KEY;
const server = new McpServer({ name: 'dart', version: '1.0.0' });

function client(): OpenDartClient {
  if (!apiKey) throw new Error('DART_API_KEY is not set');
  return new OpenDartClient({ apiKey });
}

server.tool('company_info', 'Get OpenDART company info by corp_code.', {
  corp_code: z.string().min(8),
}, async ({ corp_code }) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(await client().companyInfo(corp_code), null, 2) }],
}));

server.tool('list_filings', 'List OpenDART filings.', {
  corp_code: z.string().optional(),
  from: z.string().regex(/^\d{8}$/).optional(),
  to: z.string().regex(/^\d{8}$/).optional(),
  page_count: z.number().int().min(1).max(100).default(10),
}, async (args) => ({
  content: [{
    type: 'text' as const,
    text: JSON.stringify(await client().listFilings({
      corpCode: args.corp_code,
      bgnDe: args.from,
      endDe: args.to,
      pageCount: args.page_count,
    }), null, 2),
  }],
}));

server.tool('financial_statements', 'Get single-company financial statements.', {
  corp_code: z.string().min(8),
  year: z.string().regex(/^\d{4}$/),
  report_code: z.string().default('11011'),
}, async (args) => ({
  content: [{
    type: 'text' as const,
    text: JSON.stringify(await client().singleFinancialStatement(args.corp_code, args.year, args.report_code), null, 2),
  }],
}));

await server.connect(new StdioServerTransport());
```

**Step 2: Register MCP server with Claude SDK**

Modify normal-query options in `container/agent-runner/src/index.ts`:

- Add `mcp__dart__*` to `allowedTools`.
- Compute `dartMcpServerPath`.
- Add `dart` MCP server only when `process.env.DART_API_KEY` is present.

Implementation shape:

```ts
const dartMcpServerPath = path.join(__dirname, 'dart-mcp-stdio.js');
const mcpServers = {
  nanoclaw: { ... },
  ...(process.env.DART_API_KEY
    ? {
        dart: {
          command: 'node',
          args: [dartMcpServerPath],
          env: { DART_API_KEY: process.env.DART_API_KEY },
        },
      }
    : {}),
};
```

**Step 3: Update capabilities**

Modify `container/skills/capabilities/SKILL.md` to include:

```md
If `DART_API_KEY` is set:
- MCP: `mcp__dart__company_info`, `mcp__dart__list_filings`, `mcp__dart__financial_statements`
- CLI: `dart-tool`
```

**Step 4: Verify**

Run:

```bash
npm --prefix container/agent-runner run build
./container/build.sh
```

Then with a real env key only in the local environment:

```bash
DART_API_KEY=redacted ./scripts/dev-shell.sh job
```

Inside the shell:

```bash
dart-tool company 00149293
```

Expected: JSON response with OpenDART company fields. Do not paste or log the real key.

**Step 5: Commit**

```bash
git add container/agent-runner/src/dart-mcp-stdio.ts container/agent-runner/src/index.ts container/skills/capabilities/SKILL.md
git commit -m "feat(dart): expose OpenDART MCP tools"
```

## Task 5: Wire the Local Job Instance

**Files:**
- Modify ignored: `.env`
- Modify ignored DB row: `store/messages.db`
- Modify ignored: `groups/job/CLAUDE.md`
- Modify ignored job scripts under the mounted job workspace.

**Step 1: Store key outside git**

Add the key to host `.env` or OneCLI. For `.env`, use:

```dotenv
DART_API_KEY="..."
```

Do not commit `.env`. If the key was ever committed or shared, rotate it first.

**Step 2: Add env passthrough to job group registration**

Update the `job` group row so `container_config` includes:

```json
{
  "additionalMounts": [
    {
      "hostPath": "<host-job-workspace>",
      "containerPath": "job",
      "readonly": false
    }
  ],
  "envVars": ["DART_API_KEY"]
}
```

Use a local SQLite update script, not a tracked source file.

**Step 3: Update job CLAUDE.md**

In ignored `groups/job/CLAUDE.md`, add:

```md
## DART 사용

DART 자료가 필요한 기업분석은 먼저 `mcp__dart__*` 도구를 사용합니다.
MCP가 보이지 않으면 `dart-tool` CLI를 사용합니다.
API 키는 `DART_API_KEY` env로 주입되며, 파일/메시지/Notion에 노출하지 않습니다.
```

**Step 4: Migrate old Windows script**

For existing job scripts such as `fetch_shinhan_bank_v2.py`:

- Remove hardcoded API key.
- Replace Windows output paths with `/workspace/extra/job/<company>/...`.
- Prefer calling `dart-tool` or the shared DART client behavior instead of duplicating endpoint logic.
- Save outputs under the company folder and include source metadata.

Minimal temporary Python fallback if a script must remain Python:

```py
import os
from pathlib import Path

API_KEY = os.environ["DART_API_KEY"]
OUT_DIR = Path("/workspace/extra/job/shinhan/dart")
OUT_DIR.mkdir(parents=True, exist_ok=True)
```

**Step 5: Restart NanoClaw**

Run:

```bash
pkill -f '<nanoclaw-root>/dist/index.js'
cd <nanoclaw-root>
nohup node dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log &
```

Expected logs:

```text
Discord bot connected
NanoClaw running
```

## Task 6: Full Verification

**Files:**
- No new files unless failures require fixes.

**Step 1: Static checks**

Run:

```bash
npm test
npm run typecheck
npm run check:boundaries
npm --prefix container/agent-runner run build
```

Expected: all pass.

**Step 2: Container build**

Run:

```bash
./container/build.sh
```

Expected: Docker image builds successfully.

**Step 3: Runtime smoke test**

Run:

```bash
./scripts/dev-shell.sh job
```

Inside container:

```bash
test -n "$DART_API_KEY" && echo "DART key injected"
which dart-tool
dart-tool filings --corp-code 00149293 --from 20260101 --page-count 1
```

Expected:
- key is present but not printed,
- `dart-tool` exists,
- OpenDART returns JSON.

**Step 4: Chat smoke test**

In the job Discord channel, ask:

```text
신한은행 corp_code 00149293의 최근 공시 3개를 DART 도구로 확인하고 제목만 요약해줘.
```

Expected:
- agent uses `mcp__dart__list_filings` or `dart-tool`,
- no key is printed,
- answer includes filing names and dates.

**Step 5: Commit final generated dist if tracked**

Check whether `container/agent-runner/dist` is tracked:

```bash
git ls-files container/agent-runner/dist | head
```

If tracked, rebuild and commit generated JS/d.ts outputs:

```bash
git add container/agent-runner/dist
git commit -m "build(container): update agent runner artifacts"
```

**Step 6: Final boundary check**

Run:

```bash
git status --short
npm run check:boundaries
```

Expected:
- no secrets or instance files staged,
- boundary check clean.
