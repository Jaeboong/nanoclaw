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
