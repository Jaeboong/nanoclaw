# jira-automation — Codex 가이드

Codex 가 매 세션 자동 로드하는 에이전트 진입점. 내용은 `CLAUDE.md` 와 실질적으로 동일.

## 절대 규칙

1. **`jira` CLI 를 사용한다.** raw Python 스크립트를 치지 말 것 — 로직은 `jira_automation/` 패키지로 이주했다.
2. **CWD 무관하게 `jira` 바이너리 호출.** `cd` 요구사항 없음. PATH 에 없으면 `docs/setup.md`.
3. **이슈 본문은 `jira search` 가 만든 임시 markdown 파일을 읽는다.** stdout 에 `TEMP_FILE_PATH:<path>` / `ISSUE_COUNT:<n>` 두 줄이 나옴. 터미널 출력에서 본문 파싱 금지 (UTF-8 깨짐).
4. **프로젝트 스코프는 `.env` 의 `JIRA_PROJECT_KEY` 로 고정.** 별도 지시 없으면 설정 키로 재작성.
5. **생성/수정 전 `~/.config/jira-automation/convention.md` 숙지.**
6. **세션 첫 명령은 `jira doctor`.**

## 무엇을 언제 읽을지

| 상황 | 먼저 읽기 |
|---|---|
| 낯선 프로젝트 | `README.md` |
| 설치/설정 오류 | `docs/setup.md` |
| 이슈 검색 | `docs/reading.md` |
| 생성/수정/에픽 연결 | `docs/writing.md` + `~/.config/jira-automation/convention.md` |
| 에러 발생 | `docs/troubleshooting.md` |

## 서브커맨드

- `jira doctor`
- `jira search [--jql ... | --project X] [--filter KW] [--limit N] [--out PATH]`
- `jira create --summary ... [--type Task|Story|Bug] [--points N] [--epic KEY] [...]`
- `jira update <KEY> [--status ...] [--assign me] [--comment ...] [...]`
- `jira link <ISSUE_KEY> <EPIC_KEY>`

자세한 플래그는 `jira <cmd> --help`.
