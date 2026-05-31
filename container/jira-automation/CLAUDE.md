# jira-automation — Claude Code 가이드

Claude Code 가 매 세션 자동 로드하는 에이전트 진입점.

## 절대 규칙

1. **`jira` CLI 를 사용한다.** raw Python 스크립트 (`python search_issues.py ...`) 를 치지 말 것 — 그 스크립트들은 `jira_automation/` 패키지로 이주했다.
2. **CWD 무관하게 `jira` 바이너리를 호출.** `cd` 요구사항 없음. PATH 에 없으면 `docs/setup.md` 의 설치 절차.
3. **이슈 본문은 `jira search` 가 만든 임시 markdown 파일을 Read 도구로 읽는다.** stdout 으로 `TEMP_FILE_PATH:<path>` / `ISSUE_COUNT:<n>` 두 줄이 나오니 경로만 파싱하고 파일을 읽을 것. 터미널 출력에서 본문을 파싱하지 말 것 (UTF-8 깨짐 위험).
4. **프로젝트 스코프는 `.env` 의 `JIRA_PROJECT_KEY` 로 고정.** 사용자가 다른 키를 언급해도 별도 지시 없으면 설정된 키로 재작성. `--project` 는 예외 상황에서만.
5. **생성/수정 전 `~/.config/jira-automation/convention.md` 숙지.** (팀 규약 — 라벨, Story Point 스케일)
6. **세션 첫 명령은 `jira doctor`.** `.env` 경로, 연결, 커스텀 필드 ID 한 번에 확인.

## 무엇을 언제 읽을지

| 상황 | 먼저 읽기 |
|---|---|
| 이 프로젝트가 낯설 때 | `README.md` |
| 첫 세션 / 설치/설정 오류 | `docs/setup.md` |
| 이슈 검색 | `docs/reading.md` |
| 이슈 생성/수정/에픽 연결 | `docs/writing.md` + `~/.config/jira-automation/convention.md` |
| 에러 발생 시 | `docs/troubleshooting.md` |

## 서브커맨드 요약

- `jira doctor` — 설정/연결 진단
- `jira search [--jql ... | --project X] [--filter KW] [--limit N] [--out PATH]`
- `jira create --summary ... [--type Task|Story|Bug] [--points N] [--epic KEY] [...]`
- `jira update <KEY> [--status ...] [--assign me] [--comment ...] [--points N] [...]`
- `jira link <ISSUE_KEY> <EPIC_KEY>`

자세한 플래그는 `jira <cmd> --help`.
