# jira-automation

에이전트(Claude Code / Codex 등)가 소비하도록 설계된 Jira CLI.

하네스가 raw Python 스크립트를 직접 치지 않고, 단일 진입점 `jira <서브커맨드>` 로만 호출하도록 되어 있습니다.

## 설치

### 원클릭 (권장) — Claude Code 에서

레포를 클론하고 Claude Code 로 열면 `/setup` 슬래시 커맨드가 자동 활성화됩니다. 실행하면 대화형으로 `.env` 값을 받아 `~/.config/jira-automation/.env` 에 저장하고, pipx 설치 + 스킬 심링크 + 연결 진단까지 한 번에 처리합니다.

```bash
git clone https://github.com/Jaeboong/Jira_automation
cd Jira_automation
claude          # 세션 시작
> /setup
```

### 수동

```bash
pipx install git+https://github.com/Jaeboong/Jira_automation
```

`jira` 바이너리만 PATH 에 올립니다. 에이전트 스킬 등록은 `docs/skill-registration.md` 참고.

### 개발자

```bash
git clone https://github.com/Jaeboong/Jira_automation
cd Jira_automation
python3 -m venv .venv && ./.venv/bin/pip install -e .
```

## 설정

`.env.example` 를 복사해 `.env` 로 만들고 본인 값 기입. Jira API 토큰: https://id.atlassian.com/manage-profile/security/api-tokens

`.env` 탐색 순서 (앞에서 찾으면 종료):

1. `$JIRA_CONFIG_DIR/.env` — 명시적 오버라이드
2. `./.env` — 현재 CWD
3. `~/.config/jira-automation/.env` — XDG user config

셋 중 어디에도 없으면 `jira` 는 로드 실패로 종료 (조용히 엉뚱한 프로젝트로 요청이 나가는 것을 차단).

`jira doctor` 로 설정/연결/커스텀 필드 ID 를 한 번에 진단할 수 있습니다.

## 사용

```bash
jira --help
jira doctor                                 # 설정 진단
jira search --limit 10                      # 임시 .md 로 저장 후 경로 출력
jira search --jql 'assignee = currentUser() AND status != Done'
jira create --summary "[BE] 로그인 API" --type Story --points 3 --epic PROJ-12
jira update PROJ-42 --status "In Progress" --assign me
jira link PROJ-42 PROJ-12
```

### 에이전트 계약

`jira search` 는 stdout 에 다음 두 줄을 출력합니다:

```
TEMP_FILE_PATH:/tmp/xxx.md
ISSUE_COUNT:N
```

에이전트는 이슈 본문을 터미널에서 파싱하지 말고, 위 경로의 파일을 Read 도구로 읽어야 합니다 (UTF-8 안전).

## 에이전트 가이드

| 하네스 | 자동 로드 |
|---|---|
| Claude Code | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| 스킬 매처 | `SKILL.md` |

주제별 상세:

- `docs/setup.md` — 환경/설치/설정 트러블
- `docs/skill-registration.md` — 스킬로 자동 인식시키기 (클론 → 심링크)
- `docs/reading.md` — 검색 사용법
- `docs/writing.md` — 생성/수정/에픽 연결
- `docs/troubleshooting.md` — 에러 패턴
- `conventions/*.md` — 팀 Jira 컨벤션 파일들. `/setup` 이 이 디렉토리를 스캔해 `.md` 파일을 자동 선택 (1개면 자동 적용, 여러 개면 선택 묻기)
- 실사용 컨벤션은 `~/.config/jira-automation/convention.md` — `/setup` 이 여기에 저장

## 파일 구조

```
jira_automation/        # 패키지 (jira CLI 구현체)
  cli.py                # argparse 진입
  config.py             # .env 탐색
  client.py             # Jira 연결 + 커스텀 필드 탐색
  search.py create.py update.py link.py doctor.py
pyproject.toml          # pipx / pip install 대상
docs/                   # 주제별 상세 문서
.env.example
```
