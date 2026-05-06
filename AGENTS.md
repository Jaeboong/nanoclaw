# Agent Rules

This file is the cross-agent entry point. Any agent — Claude Code, Codex, or other — that edits this repository must follow it. Claude-specific notes live in `CLAUDE.md`; this file is for rules every agent shares.

## 1. Boundary harness (mandatory)

Every change belongs to one of three tiers — **core**, **module**, **instance**. Read `docs/HARNESS.md` before making changes. Before staging files, classify them:

- **core** — common runtime, no user/project specifics. Commit.
- **module** — opt-in, parameterized capability. Commit.
- **instance** — user/project specific (channel IDs, hostnames, personal dashboards, secrets). **Do not commit.**

If a single change mixes tiers, split it. Personal data goes to ignored paths (`ops/**/instances/`, `ops/**/local/`, `groups/<name>/`, `.env`, `.nanoclaw/`, `docs/plans/completed_plans/`, etc.).

Before publishing, run `npm run check:boundaries` and address any reported tracked-instance leaks.

## 2. Delegation contract

When delegating work to a sub-agent (Codex, Sonnet sub-agent, Explore agent, etc.):

- Pass `docs/HARNESS.md` and `AGENTS.md` references in the delegation prompt.
- State the expected tier of the change in the prompt.
- Do not let a sub-agent invent new instance directories outside the conventions above.

## 3. Repository conventions

- Source code changes (`src/`, `container/`) follow the rules in `CONTRIBUTING.md` (bug fixes / simplifications only; capabilities go in skills or modules).
- Skills follow `CONTRIBUTING.md` skill-type guidance.
- Documentation files added under `docs/` should not contain channel IDs, user paths, or project-specific identifiers unless the file itself is an instance artifact (which means it must be ignored).

## 4. Commit hygiene

- Never commit `.env`, secrets, or content under any `instances/` or `local/` directory.
- Never commit absolute host paths (`/home/<user>/...`) in tracked files. Use environment variables or relative paths.
- Hardcoded long numeric IDs (Discord channel IDs, Telegram chat IDs) should never appear in tracked source.

## 5. When you are unsure

- Stop and ask the user, or
- Default to treating the file as **instance** until clarified.

The harness is a guard, not a creativity tax. Most changes fit cleanly into one tier — when they don't, that is itself a signal to split the change.
