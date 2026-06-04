# Upstream report — `compact_boundary` is misclassified as a failed agent turn

**Status:** draft for upstream (issue / PR against `nanocoai/nanoclaw`).
**Scope:** upstream-core only. The affected files are byte-identical to
`upstream/main`; this fork does **not** patch them (see
[UPSTREAM-MERGE.md](../UPSTREAM-MERGE.md) — fork custom = additive modules, core
fixes go upstream).

## Summary

When the Claude Agent SDK performs context compaction it emits a
`compact_boundary` system message mid-stream. The container runner maps it to a
`result`-with-text event carrying the string `"Context compacted (N tokens
compacted)."`. The poll loop then runs that text through `dispatchResultText`,
which is built to deliver **agent** output wrapped in
`<message to="name">…</message>` blocks. System-generated bare text has no such
block, so it is misclassified as a *failed, unwrapped agent turn*. Two
consequences follow from this one misclassification:

1. **(genuine defect) Spurious "response not delivered" nudge.** The poll loop
   pushes a `<system>Your response was not delivered — it was not wrapped in
   <message to="name">…</message> blocks … Please re-send your response.</system>`
   message back into the agent's query. The agent never produced a response to
   re-send; it was a system compaction event. This injects a confusing,
   incorrect instruction into the live conversation.
2. **(arguably by-design) Swallowed confirmation.** The `"Context compacted"`
   text is treated as scratchpad and never delivered to any channel, so a user
   who triggered `/compact` sees no confirmation. (Silent compaction may be
   intended; we flag it as a symptom of the same misclassification, not
   necessarily a bug.)

## Affected code (v2.0.71, paths under `container/agent-runner/`)

- `src/providers/claude.ts` (~L449–452) — `compact_boundary` → `yield { type:
  'result', text: 'Context compacted${detail}.' }`. Mapping a system event onto
  the same `result`-with-text channel the agent's own final answer uses is the
  root cause.
- `src/poll-loop.ts` (~L443–456) — on a `result` with text, calls
  `dispatchResultText`; when `hasUnwrapped` (no `<message to>` block, which is
  always true for the compaction string) and `!unwrappedNudged`, pushes the
  re-send nudge.
- `src/poll-loop.ts` `dispatchResultText` (~L494–533) — `sent === 0 &&
  scratchpad` ⇒ `hasUnwrapped = true` for the bare compaction text.

## Trigger frequency

- **Manual `/compact`:** confirmed. The compaction is the whole turn, so the
  `compact_boundary` result is the only output → `hasUnwrapped` true → nudge
  fires (`unwrappedNudged` resets per turn at poll-loop ~L380).
- **Automatic compaction** (at `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, default
  165000): likely but unconfirmed. `compact_boundary` arrives mid-stream
  alongside a real wrapped result; whether the bare-text result is processed in
  its own turn-cycle (firing the nudge) depends on SDK event ordering we did not
  trace at runtime. Worth confirming before claiming "every auto-compaction".

> Verification note: the swallow + nudge are established by reading the code
> paths (claude.ts → poll-loop.ts), not by running a live container. The paths
> are unambiguous; the *frequency* on the auto path needs a runtime check.

## Proposed fix (smallest correct change)

Stop routing a system compaction event through the agent-output dispatcher. Map
`compact_boundary` to a **`progress`** event instead of a `result`:

```ts
// claude.ts
} else if (subtype === 'compact_boundary') {
  const meta = (message as { compact_metadata?: { pre_tokens?: number } }).compact_metadata;
  const detail = meta?.pre_tokens ? ` (${meta.pre_tokens.toLocaleString()} tokens compacted)` : '';
  yield { type: 'progress', message: `Context compacted${detail}.` };
}
```

`progress` events are handled by `handleEvent` (poll-loop) which only `log()`s
them — so the bogus nudge disappears and nothing is mis-sent. If upstream wants
the confirmation *shown* to the user (rather than only logged), that is a
separate, deliberate choice: deliver it explicitly via the status/delivery path
rather than the wrapped-message dispatcher.

## Why this fork reports rather than patches

`claude.ts`, `poll-loop.ts`, and `formatter.ts` are byte-identical to
`upstream/main` in this fork (verified: `git diff --stat upstream/main..HEAD --
container/agent-runner/src/providers/claude.ts container/agent-runner/src/poll-loop.ts`
is empty). Patching them here would create exactly the kind of core divergence
the fork's merge discipline forbids. The clean home for the fix is upstream.

## Relation to `/compact-everywhere`

The fork's additive `/compact-everywhere` module (Task 10) gives the user an
ephemeral slash reply confirming the compaction *request* landed, which
side-steps the swallowed-ack symptom for manual invocation — but it does not and
should not fix the upstream nudge defect.
