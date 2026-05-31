---
name: discord-formatting
description: Format messages for Discord using color-coded section embeds. Use when responding to Discord channels (folder starts with "dc_" or chat JID starts with "dc:").
---

# Discord Message Formatting

When the group folder starts with `dc_` or the chat JID starts with `dc:`, your response is rendered as Discord **embeds** with color-coded sections. Each `## ` header starts a new embed; content before any header becomes the default (white) embed.

## How to detect Discord context

Check your group folder name or JID:
- Folder starts with `dc_` (e.g., `dc_general`, `dc_myserver-random`)
- Or chat JID starts with `dc:` (e.g., `dc:1234567890123456`)

## Section headers (auto color-mapped)

Use these `## ` headers when a response has distinct content types:

| Header | Color | Use when |
|--------|-------|----------|
| `## 🔍 분석` | 🟢 Green | Diagnosis, investigation, reading code/logs/data |
| `## 📌 결론` | 🔵 Blue | Decision, recommendation, final answer |
| `## ⚠️ 주의` | 🔴 Red | Warning, error, risky operation, something broke |
| `## ❓ 질문` | 🟡 Yellow | You need the user to confirm or clarify before next step |

Content **before** any `##` header renders as a white "default" embed — use it for a short intro sentence or when no section fits.

The emoji is optional — `## 분석` matches the same as `## 🔍 분석`. Keep it for consistency.

## When NOT to section

**One-liner or trivial answers** ("응", "완료", "파일은 `foo.ts` 야") must be a single plain response with **no section headers**. Forcing sections onto trivial replies is ugly and noisy.

Rule of thumb: only use section headers when the response has ≥2 distinct pieces AND at least one of them fits an analysis/conclusion/warning/question pattern. A single-topic answer stays in the default section.

## Section rules

- **Order matters** — sections render in the order you write them. Typical flow: brief intro → 🔍 분석 → 📌 결론. Or: 🔍 분석 → ⚠️ 주의 (if you found something dangerous).
- **Don't nest** `##` headers inside a section. If you need sub-structure within a section, use `###` or bullet lists.
- **Skip unknown headers** — `## 기타` or custom labels fall back to default (white). Stick to the four above.
- **No footer / close line** — the host auto-appends a footer with tool usage and elapsed time.

## Examples

**Good — typical multi-part response:**

```
파일 확인했어.

## 🔍 분석
`sendMessage`가 2000자 기준으로 슬라이스해서 코드블록 가운데가 잘려.
현재 로직은 단순히 `text.slice(i, i + MAX_LENGTH)`만 부름.

## 📌 결론
경계 탐지 추가 필요 — `MAX_LENGTH` 내에서 가장 가까운 `\n\n`이나 ` ``` ` 경계를 찾아 자르는 방식으로 바꾸자.
```

**Good — destructive op warning:**

```
## ⚠️ 주의
이 명령은 `data/sessions/` 아래 **모든** 세션 캐시를 지워. 진행 중인 컨테이너가 있으면 상태가 꼬일 수 있음.

## ❓ 질문
그래도 진행할까? 아니면 특정 그룹 폴더만 지울까?
```

**Good — trivial reply (no sections):**

```
응, 완료했어.
```

**Bad — forcing sections on a one-liner:**

```
## 📌 결론
응.
```

**Bad — section header inside a code block:**

````
```
## 🔍 분석
```
````
(These won't parse as sections — headers inside fenced code are ignored.)

## Discord markdown reminders

Discord supports standard markdown for embed descriptions, but the host **auto-sanitizes** these before rendering, so you can write them naturally:
- `####+` (H4+) → auto-converted to `**bold**`
- `| col | table |` → auto-wrapped in a code block (monospace alignment)
- `- [ ] task` / `- [x] done` → auto-converted to `• ☐ task` / `• ☑ done`
- `---` horizontal rules → auto-collapsed to blank line

Render naturally: `**bold**`, `*italic*`, ` `` `code` `` `, ` ```lang\ncode``` `, `> quote`, `||spoiler||`, `### H3`, `[text](url)`, numbered/bulleted lists.

## Optional frontmatter (extra embed fields)

You can prepend a YAML frontmatter block to **add extra embed metadata** — author name, fields (key/value rows), thumbnail image, timestamp. These are all optional. **Omit the block entirely when you don't need any of them** — that's the normal case.

### Format

```
---
author: Andy (Opus 4.7)
title: 요약 리포트
url: https://example.com/report/42
thumbnail: https://example.com/icon.png
image: https://example.com/big.png
timestamp: true
fields: [{"name":"위험도","value":"낮음","inline":true},{"name":"영향 파일","value":"3","inline":true}]
---

## 🔍 분석
...
```

### Supported keys

| Key | Type | What it does |
|-----|------|--------------|
| `author` | string | Small name shown above the title (e.g. your role/persona) |
| `title` | string | Bold title line at top |
| `url` | URL | Makes `title` clickable |
| `thumbnail` | URL | Small image top-right |
| `image` | URL | Large image below description |
| `timestamp` | `true` or ISO string | Shows relative time in footer (e.g. "방금 전") |
| `fields` | JSON array | Key/value rows below description. Max 25. `inline: true` packs them side by side. |

### Rules

- Frontmatter is applied to the **first embed only** (top of the message).
- All keys are optional — pick only what you need.
- `fields` must be a **single-line JSON array** (not multi-line YAML blocks). Use `[{...},{...}]` shape.
- If parsing fails (invalid JSON, unknown keys), the frontmatter silently falls back to being ignored — no error visible to user.
- **Don't use frontmatter on trivial one-liner responses.** Same rule as sections: only when it adds real info.

### When to use which field

- **author** — when your persona matters (e.g., running as "Researcher" subagent vs main agent).
- **fields** — when you have structured metadata that would clutter prose: risk level, counts, status, deadlines.
- **thumbnail/image** — when an image is central to the answer (chart, screenshot, preview).
- **timestamp** — when the freshness of the data matters (live status reports, scheduled task results).
- **title+url** — when the response is essentially pointing at an external resource.
