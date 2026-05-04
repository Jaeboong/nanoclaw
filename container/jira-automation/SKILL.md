---
name: jira
description: Use when the user explicitly mentions Jira or 지라, or asks to search, create, update, assign, link, or review Jira issues, epics, sprints, and project work with the bundled jira CLI.
---

# Jira

이 스킬은 `jira` CLI (패키지 `jira_automation`) 를 감쌉니다.

## 첫 액션

1. `jira --help` 로 현재 서브커맨드 surface 확인.
2. `jira doctor` 로 설정/연결 상태 확인 — 실패 시 `docs/setup.md`.

`jira` 바이너리는 `pipx install` 로 PATH 에 들어있다고 가정합니다. 실행 실패 시 `docs/setup.md` 의 설치 절차를 따르세요.

## 하네스별 진입점

- Claude Code → `CLAUDE.md`
- Codex → `AGENTS.md`

## 주제별 상세

- `docs/setup.md` — 설치/`.env`/진단
- `docs/reading.md` — `jira search`
- `docs/writing.md` — `jira create` / `update` / `link`
- `docs/troubleshooting.md` — 에러 패턴
- `~/.config/jira-automation/convention.md` — 이슈 생성/수정 전 필독 (팀 규약)
