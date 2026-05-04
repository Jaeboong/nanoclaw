# Troubleshooting

첫 단계는 항상 `jira doctor`. 설정/연결/커스텀 필드를 한 번에 검증합니다.

## 에러 표

| 증상 | 원인 | 조치 |
|---|---|---|
| `jira: command not found` | `pipx` 설치 안 됐거나 PATH 문제 | `docs/setup.md` 의 설치 절차, `pipx ensurepath` 후 새 쉘 |
| `.env 파일을 찾을 수 없습니다` | 3개 탐색 경로 모두 없음 | `$JIRA_CONFIG_DIR/.env`, `./.env`, `~/.config/jira-automation/.env` 중 하나에 `.env.example` 복사 |
| `필수 값이 누락되었습니다` | `.env` 에 키 비었거나 placeholder | 네 필수 키를 본인 값으로 채움 |
| `401 Unauthorized` | 자격증명 오류 | `JIRA_EMAIL`, `JIRA_API_TOKEN` 재확인. 토큰은 https://id.atlassian.com/manage-profile/security/api-tokens |
| `403` + "IP not allowed" | 회사 IP 제한 | Jira 관리자에게 IP 화이트리스트 요청 |
| `JQL error` | JQL 문법 오류 | 문자열 값 따옴표: `status = "해야 할 일"`, 복합 조건에 괄호 |
| `Story Points 필드를 자동 탐색하지 못했습니다` | 인스턴스별 필드 ID 비표준 | `jira doctor` 로 후보 확인 후 `.env` 에 `JIRA_STORY_POINTS_FIELD=customfield_XXXXX` 지정 |
| `Epic Link 필드를 자동 탐색하지 못했습니다` | 위와 동일 | `.env` 에 `JIRA_EPIC_LINK_FIELD=customfield_XXXXX` |
| 상태 전환 실패 `상태 'X' 로의 전환을 찾을 수 없습니다` | 워크플로우 레이블 미일치 | 에러 메시지에 출력된 "가능:" 목록 중 하나로 재시도 |
| `--project ""` 같은 빈 값 | 쉘이 `$JIRA_PROJECT_KEY` 를 빈 문자열로 확장 | 플래그 제거. 설정에서 자동 로드됨 |

## 수동 진단

### 설정 파일이 어디서 로드되는지 확인

```bash
jira doctor
# [CONFIG] env file = /경로/.env 첫 줄 참고
```

### 현재 인스턴스의 커스텀 필드 후보 조회

`jira doctor` 가 `UNRESOLVED` 를 반환할 때:

```bash
python3 -c "
from jira_automation.config import load_config
from jira_automation.client import connect
j = connect(load_config())
for f in j.fields():
    n = f.get('name', '')
    if 'Point' in n or 'Epic' in n:
        print(f['id'], '|', n)
"
```

후보 id 를 `.env` 에 `JIRA_STORY_POINTS_FIELD` / `JIRA_EPIC_LINK_FIELD` 로 박으세요.

## 다음 단계

- Setup → `docs/setup.md`
- 읽기 → `docs/reading.md`
- 쓰기 → `docs/writing.md`
