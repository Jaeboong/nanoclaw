# Setup

`jira` CLI 설치와 설정. 워크스페이스당 한 번.

## 사전 요구사항

- Python 3.10+
- `pipx` (권장) 또는 venv
- Jira API 토큰: https://id.atlassian.com/manage-profile/security/api-tokens

## 설치

### A. pipx (권장, 사용자용)

```bash
pipx install git+https://github.com/Jaeboong/Jira_automation
```

이후 어디서든 `jira` 실행 가능. 업그레이드는 `pipx upgrade jira-automation`.

### B. editable venv (개발자용)

```bash
git clone https://github.com/Jaeboong/Jira_automation
cd Jira_automation
python3 -m venv .venv
./.venv/bin/pip install -e .
# 이 venv 에서는 ./.venv/bin/jira 로 호출
```

## `.env` 작성

`.env.example` 를 복사하고 본인 값을 채웁니다. 저장 위치는 아래 탐색 순서 중 하나면 됩니다.

```
JIRA_URL=https://your-company.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-api-token-here
JIRA_PROJECT_KEY=PROJ

# 선택 — 미지정 시 jira doctor 가 자동 탐색
# JIRA_STORY_POINTS_FIELD=customfield_10031
# JIRA_EPIC_LINK_FIELD=customfield_10014
# JIRA_TIMEOUT=10
```

## `.env` 탐색 순서

`jira` 는 아래 순서로 `.env` 를 찾습니다. 앞에서 찾으면 종료.

1. `$JIRA_CONFIG_DIR/.env` — 명시적 오버라이드 (CI/다중 프로젝트에 유용)
2. `./.env` — 현재 CWD
3. `~/.config/jira-automation/.env` — XDG user config (pipx 유저 권장)

셋 중 어디에도 없으면 loud fail. 네 필수 키 (`JIRA_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`) 중 하나라도 비어 있으면 loud fail.

## 연결/필드 진단

```bash
jira doctor
```

출력 예:

```
[CONFIG]   env file   = /home/you/.config/jira-automation/.env
[CONFIG]   JIRA_URL   = https://ssafy.atlassian.net
[CONFIG]   project    = PROJ
[CONNECT]  OK, as 홍길동
[FIELD]    story points = customfield_10031 (auto)
[FIELD]    epic link    = customfield_10014 (auto)
```

`auto` 가 `UNRESOLVED` 로 나오면 `.env` 에 `JIRA_STORY_POINTS_FIELD` / `JIRA_EPIC_LINK_FIELD` 를 직접 지정하세요. 후보 탐색이 필요하면 `docs/troubleshooting.md`.

## `.env` 는 쉘이 아니라 Python 프로세스에 로드됩니다

`python-dotenv` 가 `jira` 기동 시 파일을 읽어 `os.environ` 에 적재합니다. 쉘에서 `$JIRA_PROJECT_KEY` 를 쓰면 빈 문자열입니다. CLI 에 프로젝트 키를 넘길 필요도 없습니다 — 설정에서 자동으로 가져옵니다.
