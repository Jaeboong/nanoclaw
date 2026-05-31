# Upstream-merge discipline (harness rule)

> Fork-only doc (not in `upstream/main`). It exists so that **future `git pull`
> from upstream stays a clean, low-conflict merge** — the prime directive of
> this fork. Read it before adding ANY custom feature.

## Why this exists

This fork tracks `upstream/main` (NanoClaw v2). The original divergence (a v1
fork, 998 commits behind, different architecture) forced a one-time **replay**
onto v2. That cost is paid once. From here on, the goal is the opposite of
divergence: **every custom feature must be shaped so that pulling upstream
never (or barely) conflicts with it.**

Divergence cost is paid at every future merge, by a human resolving conflicts.
A custom feature that edits upstream-core logic taxes every upstream pull
forever. A custom feature that lives in its own module and touches core only
through a generic seam costs nothing at merge time.

## The rule

1. **Custom features are ADDITIVE modules.** New files under `src/modules/`,
   `src/channels/<channel>-*.ts`, `container/skills/`, or `setup/` — never
   inline edits to upstream core logic. A new file can't conflict with an
   upstream change.

2. **Touch upstream core only through a seam, and only minimally.** If the
   feature must hook into core, use (in order of preference):
   - an **existing** upstream registry/hook — `registerChannelAdapter`,
     `registerDeliveryAction`, `setSenderResolver`, `setAccessGate`,
     `setMessageInterceptor`, `registerResponseHandler`, the command-gate, …;
   - failing that, add a **new generic seam** to core in the same `setX(fn)` /
     `registerX(fn)` style upstream already uses (e.g.
     `setForwardedInteractionRouter` in `chat-sdk-bridge.ts`). Keep it generic
     (no fork-specific names/imports in core) so it reads like an upstream
     primitive — and could be sent upstream as a PR.
   - The module wires itself in via a **side-effect import** (one line in the
     channel/module entry). The allowed core delta is the seam declaration plus
     that import — not custom branching logic.

3. **Never put feature logic in core.** Core calls the seam; the module owns
   the behavior. If you find yourself adding an `if (isOurFeature)` branch to an
   upstream function, stop and turn it into a seam + module instead.

4. **Record every upstream-core edit in the divergence ledger.** Any change to
   a file that exists in `upstream/main` goes in the ledger (see
   `project_v2_migration_progress` memory) with one line on what and why. The
   ledger is the merge-cost budget; keep it short and justified.

5. **Prefer upstreaming.** A generic seam that helps any adapter is a candidate
   PR to upstream. Once merged upstream, our delta drops to zero.

## Checklist for a new custom feature

- [ ] Lives in its own file(s); no upstream-core logic edited.
- [ ] If core is touched: it's a generic `setX`/`registerX` seam + a one-line
      side-effect import, nothing more.
- [ ] No fork-specific identifier appears in an upstream-core file.
- [ ] `git diff upstream/main --stat` shows new files, not sprawling core edits.
- [ ] Divergence ledger updated if any `upstream/main` file changed.
- [ ] `npm run check:boundaries` clean (no personal data leaking to git).

## Worked example — slash/interaction framework (Task 7)

- **Module:** `src/channels/discord-interactions.ts` — the whole registry,
  dispatch, auth, REST registration, and Discord callback HTTP. Additive; zero
  merge risk.
- **Core seam:** `chat-sdk-bridge.ts` gains `setForwardedInteractionRouter()`
  (generic, Discord-free) + one `if (router && await router(...)) return;` call.
  That's the entire core delta beyond a correctness fix (gating the existing
  `ncq:` branch on its prefix). `command-gate.ts` exports `isAdmin` (one
  keyword) so module auth matches typed-command auth by construction.
- **Wiring:** `src/channels/discord.ts` (already a fork/skill file) calls
  `setForwardedInteractionRouter(routeForwardedInteraction)` and fires REST
  registration — a few lines in a non-core file.
