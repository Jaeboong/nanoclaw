# Reading Issues

모든 조회는 `jira search`. 결과는 markdown 파일에 저장되고 stdout 에는 경로만 출력됩니다.

## 읽기 계약 (반드시 지킬 것)

1. `jira search ...` 실행
2. stdout 의 `TEMP_FILE_PATH:<path>` 라인 파싱
3. 해당 markdown 파일을 Read 도구로 읽기
4. 사용자에게 정리된 요약 제시

**터미널 출력에서 이슈 본문을 파싱하지 말 것** — UTF-8 깨짐, 여러 줄 설명 파싱 실패 위험.

## 사용법

```bash
jira search [--jql JQL | --project KEY] [--filter KEYWORD] [--limit N] [--out PATH]
```

`--project` 는 기본값이 `.env` 의 `JIRA_PROJECT_KEY` — **일반적으로 생략**합니다.

| Flag | 용도 |
|---|---|
| `--jql` | 직접 JQL. 지정 시 `--project`/`--filter` 무시 |
| `--project` | 프로젝트 스코프 오버라이드 (비권장) |
| `--filter` | summary/description 에 대한 대소문자 무시 키워드 필터 |
| `--limit` | 최대 결과 (기본 100) |
| `--out` | 저장 경로. 미지정 시 임시 파일 |

### 출력 형식

```
TEMP_FILE_PATH:/tmp/tmpXXXXXXXX.md
ISSUE_COUNT:N
```

## 예시

```bash
# 설정된 프로젝트 전체
jira search

# 키워드 필터
jira search --filter "WebSocket"

# 내게 할당된 진행 중 이슈
jira search --jql 'assignee = currentUser() AND status != Done'

# 최근 7일 이내 업데이트된 에픽만
jira search --jql 'issuetype = Epic AND updated >= -7d'

# 특정 경로로 저장
jira search --out ./last_search.md
```

JQL 문자열 안의 프로젝트 키/값은 **리터럴로 작성**하세요. `$JIRA_PROJECT_KEY` 같은 쉘 확장은 동작하지 않습니다.

## JQL 빠른 참조

```
project = PROJ
project = PROJ AND issuetype = Epic
project = PROJ AND status = "해야 할 일"
assignee = currentUser()
key in (PROJ-1, PROJ-3)
project = PROJ AND updated >= -7d
```
