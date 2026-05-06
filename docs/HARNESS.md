# Boundary Harness — Common vs Personal

Every change to this repository falls into one of three tiers. The harness exists so any contributor — human or agent — can place a change in the correct tier without guessing, and so personal data does not accidentally end up in version control.

## Three tiers

| Tier | Definition | Goes to git? | Examples in this repo |
|---|---|---|---|
| **core** | Common runtime and contracts that every install needs. Generic, parameterized, no project- or user-specific values. | Yes | `src/`, `container/`, `setup/`, top-level configs |
| **module** | Opt-in, reusable unit (capability, integration, parser, dashboard template). Must be parameterized so any user can adopt it. | Yes | `.claude/skills/`, `container/skills/`, `ops/<area>/modules/` |
| **instance** | Concrete instantiation by a specific user or project. Holds channel IDs, project names, host paths, secrets, hand-tuned dashboards. | **No** (gitignored) | `groups/<name>/`, `.env`, `.nanoclaw/`, `ops/<area>/instances/`, `src/tone/<personal>.ts` |

The boundary already exists culturally in the repo — `.gitignore` blocks `groups/*`, `.env`, `src/tone/ddonyang.ts`, `docs/plans/completed_plans/`, etc. This document makes the rule explicit.

## Decision tree

When adding or modifying a file, ask in order:

1. **Is the value identifiable to a single user, project, or deployment?**
   (channel ID, hostname, project name, host filesystem path, personal preference, secret)
   → **instance.** Place under an `instances/`, `local/`, or already-ignored area. Do not commit.

2. **Is the change opt-in capability that other users could plug in unchanged, given parameters?**
   → **module.** Parameterize anything user-specific. Commit.

3. **Is the change required by every install for the system to function?**
   → **core.** Commit.

If you cannot answer cleanly, the change is probably mixing tiers — split it.

## Module rules

A module must be **drop-in for another user**. Concretely:

- No hardcoded project names, channel IDs, hostnames, or absolute paths.
- Configuration values come from variables (template variables, environment, or a documented config file).
- A module folder should include a short `README.md` or `MODULE.md` describing inputs, dependencies, and how to enable it.
- If a module has no second consumer yet, that is fine — but write it as if it had one.

## Instance rules

- Lives in an ignored path. The `.gitignore` patterns are scoped (`ops/**/instances/`, `ops/**/local/`, `groups/<personal>/`, `.env`, etc.) — not blanket. New instance areas must add a narrow `.gitignore` entry.
- Never reference a single instance from a tracked file by name. Tracked files refer to instances through variables or through the host filesystem layout (e.g. install scripts that read `.env`).
- An instance may include personal dashboards, overrides, alerting destinations, scheduling rules, ignored notes (`docs/plans/completed_plans/`), etc.

## Tier mapping for current areas

| Path | Tier |
|---|---|
| `src/`, `container/`, `setup/` | core |
| `.claude/skills/<name>/` (operational, utility, feature, container) | module |
| `ops/observability-host/` (compose, prometheus, loki, promtail base, generic dashboards, generic provisioning) | core (infra) + future modules |
| `ops/observability-host/instances/<name>/` (when added) | instance |
| `groups/<name>/` (except `main/CLAUDE.md`, `global/CLAUDE.md`) | instance |
| `.env`, `*.keys.json`, `.nanoclaw/` | instance |
| `src/tone/example.ts` | module (template) |
| `src/tone/<personal>.ts` (e.g. `ddonyang.ts`) | instance |
| `docs/plans/completed_plans/` | instance (per-install work notes) |

## Mechanical guard

`scripts/check-boundaries.sh` (run via `npm run check:boundaries`) does a best-effort check for tier leakage in tracked files:

- Tracked files inside any `instances/` or `local/` directory.
- Long numeric IDs that look like Discord/Telegram channel/user IDs.
- Hardcoded `/home/<user>/` absolute paths (placeholders `node`, `agent`, `user`, `you` are excluded).
- Optional user-maintained blocklist at `.boundaries-blocklist` (gitignored) — one term per line, blank lines and `#` comments allowed.

Lines containing the literal token `boundary-allow` (in a comment) are exempt — use it for intentional public IDs, illustrative examples, or test fixtures.

### Baseline

The check compares findings against `.boundaries-baseline` (tracked). It exits 1 only on findings **not** in the baseline. This makes the gate enforceable today without requiring a one-shot cleanup of pre-existing leaks.

- `npm run check:boundaries` — fail on new leaks vs baseline.
- `npm run check:boundaries -- --update-baseline` — regenerate the baseline after a legitimate cleanup. Commit the resulting `.boundaries-baseline` so the new state becomes the floor.

The baseline should shrink over time, never grow as a way to silence new violations. If you must add to the baseline, add the underlying leak as a TODO and document why.

The script is **not** a pre-commit hook by default. Run it manually or in CI before publishing.

## When in doubt

- Lean toward **instance** if the file would embarrass another user who cloned the repo.
- Lean toward **module** if you can imagine a second consumer.
- Lean toward **core** only if removing the file would break the base install.

## Migration policy

Restructure existing code into `core/modules/instances/` layout **only when a second module candidate appears in that area**. Do not preemptively split. The harness defines the destination, not a migration deadline.
