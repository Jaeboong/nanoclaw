---
name: jira
description: Use when the user mentions Jira or 지라, or asks to search/create/update/assign/link/review Jira issues, epics, sprints, story points, or sprint planning. Wraps the bundled `jira` CLI.
---

# Jira (jira_automation CLI)

이 스킬은 컨테이너에 미리 설치된 `jira` CLI 를 감싼다. 본 컨테이너에는 다음이 이미 셋업되어 있다 — **개별 채널마다 `/setup` 다시 안 돌려도 된다**.

- **바이너리**: `/opt/jira-cli/bin/jira` (PATH 등록됨, 그냥 `jira` 호출 가능)
- **설정 디렉토리**: `/workspace/extra/jira-automation/` (호스트 `~/.config/jira-automation/` RO 마운트)
  - `.env` — JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY (=`S14P31D107`)
  - `convention.md` — SSAFY 팀 규약 (이슈 유형·제목·Story Point·상태 흐름)
- **환경 변수**: `JIRA_CONFIG_DIR=/workspace/extra/jira-automation` 자동 주입 → 어떤 CWD 에서 호출해도 설정 발견

마운트가 비어 있으면 (`ls /workspace/extra/jira-automation` 결과 없음) 사용자에게 "Jira 마운트 안 됨" 안내 후 중단해라.

## 첫 액션 (세션 처음 Jira 요청 받았을 때 한 번)

1. `jira --help` — 서브커맨드 surface 확인
2. `jira doctor` — 연결/필드 ID 진단. `[CONNECT] OK` 가 안 나오면 사용자에게 에러 발췌해서 보고하고 중단

## 절대 규칙

1. **`jira` CLI 만 사용.** raw Python 스크립트 (`python search_issues.py …`) 호출 금지 — 로직은 `jira_automation/` 패키지 안에 있다.
2. **CWD 무관.** `cd` 안 해도 된다. PATH 에 이미 있다.
3. **이슈 본문은 `jira search` 가 만드는 임시 markdown 파일을 Read 해서 본다.** stdout 두 줄 — `TEMP_FILE_PATH:<path>` / `ISSUE_COUNT:<n>` — 만 파싱. 터미널 출력 본문 파싱하지 마라 (UTF-8 깨짐).
4. **프로젝트 스코프는 `.env` 의 `JIRA_PROJECT_KEY` (`S14P31D107`) 로 고정.** 사용자가 다른 키 언급해도 별도 지시 없으면 설정 키로 재작성. `--project` 는 예외 상황에서만.
5. **이슈 생성/수정 전 `/workspace/extra/jira-automation/convention.md` Read 후 따른다** (제목 `[파트] 작업` 규칙, Story Point 1~10 기준, 상태 흐름).

## 서브커맨드 요약

```bash
jira doctor                                   # 설정/연결 진단
jira search [--jql ... | --filter KW] [--limit N] [--out PATH]
jira create --summary "[BE] 로그인 API" --type Story --points 3 --epic PROJ-12
jira update PROJ-42 --status "In Progress" --assign me --comment "..."
jira link PROJ-42 PROJ-12                     # Task → Epic 연결
```

자세한 플래그는 `jira <cmd> --help`.

## 작성 규약 (요약)

| 파트 | 용도 |
|------|------|
| FE | Frontend |
| BE | Backend |
| AI | AI / 모델 |
| DOCS | 문서 |

상태 흐름: `To Do → In Progress → Code Review → Done`

Story Point 스케일 (1=오타·문서, 5=표준, 10=쪼개야 하는 수준) — 자세한 건 convention.md.

## 워크플로 패턴

- **"내 이슈 보여줘"** → `jira search --jql "assignee = currentUser() AND status != Done"` → TEMP_FILE_PATH 읽어서 요약
- **"이슈 만들어줘 — [BE] X"** → convention.md 한 번 Read → `jira create --summary "[BE] X" --type Task|Story --points N`
- **"PROJ-42 진행으로 옮겨줘"** → `jira update PROJ-42 --status "In Progress"`
- **"PROJ-42를 PROJ-12 에픽 아래로"** → `jira link PROJ-42 PROJ-12`

## 에러 패턴

- `JIRA .env 파일을 찾을 수 없습니다` → 마운트 점검 (`ls /workspace/extra/jira-automation`). 비어있으면 호스트측 마운트 누락 — 사용자에게 보고.
- `401 Unauthorized` → 토큰 만료/잘못. 호스트 `~/.config/jira-automation/.env` 갱신 필요. 사용자에게 안내 후 중단.
- `Story Points / Epic Link ... UNRESOLVED` → `.env` 에 `JIRA_STORY_POINTS_FIELD` / `JIRA_EPIC_LINK_FIELD` 추가 필요 — 사용자에게 후보 id 보여주고 안내.
