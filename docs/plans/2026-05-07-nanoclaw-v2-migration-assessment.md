# NanoClaw v2 Migration Assessment

## Current fact

This checkout is v1.2-based. `upstream/main` is v2.0.33-era and hundreds of commits ahead.

## Do not do in-place migration until these are answered

- Is the current production bot allowed to stop during migration?
- Is Discord channel support in upstream v2 compatible with the local Discord feature set?
- Can DART tooling be applied cleanly to v2 container runner?
- Can responder routing be ported as a channel feature rather than core message-loop patch?
- Are existing SQLite data and group folders compatible or migrated?

## Recommended path

Use a separate worktree:

```bash
git worktree add ../nanoclaw-v2-migration upstream/main
```

Then replay local feature layers one at a time:

1. Discord channel support.
2. Runtime status/ledger formatting.
3. DART env passthrough and MCP tooling.
4. Responder routing.
5. Observability templates.

Do not replace the production checkout until tests and a dry-run bot pass.
