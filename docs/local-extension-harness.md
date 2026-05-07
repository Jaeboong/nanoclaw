# NanoClaw Local Extension Harness

This repository follows the common Claw extension harness:

```text
../Agents-Harness/docs/claw-extension-harness.md
```

Read this file before modifying local NanoClaw features.

## Current Position

This checkout is a local v1-based NanoClaw fork with production-facing behavior. Upstream `main` is v2-era and must not be merged into this working tree casually.

Local work should preserve these constraints:

- Push only to the personal `origin` fork.
- Never push to upstream.
- Treat upstream v2 migration as a separate worktree project.
- Keep local feature layers documented and separable.

## Local Feature Layers

| Layer | Preferred tier | Rule |
|---|---|---|
| Discord channel integration | module / channel feature | Keep channel-specific behavior inside Discord-owned files or feature helpers. |
| Responder routing | module + narrow core seam | Keep state/routing helpers isolated; only patch the orchestrator where the runtime has no seam. |
| DART tooling | module | API keys and corp-specific values must come from env or ignored instance config. |
| Observability host | module + instance | Generic dashboards/templates are tracked; concrete deployments stay ignored. |
| Group memory and channel state | instance | Do not commit concrete IDs, secrets, or personal deployment state. |

## Edit Rules

- Before editing `src/index.ts`, ask whether the behavior can live in a feature module or channel helper instead.
- Before editing `src/channels/discord.ts`, split pure helper logic from Discord call-site glue.
- Before editing DB schema, add tests and document migration behavior.
- Before adding config, prefer env/config keys over hardcoded deployment values.
- Before committing docs, check for channel IDs, host paths, and personal project names.

## Rebase / Migration Rule

Do not attempt in-place v2 migration from this checkout. Use a separate worktree and replay local layers in this order:

1. Discord channel support.
2. Responder routing.
3. DART env/tooling.
4. Observability templates.
5. Instance migration and runtime dry-run.

## Verification

For local feature changes, use the narrowest meaningful checks:

```bash
npm test -- <changed test files>
npm run typecheck
npm run check:boundaries
git diff --check
```

Docs-only changes require at least `git diff --check` and a boundary review.
