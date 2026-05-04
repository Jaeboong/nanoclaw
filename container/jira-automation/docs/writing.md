# Writing Issues

이슈 생성/수정/에픽 연결. 모든 쓰기는 `.env` `JIRA_PROJECT_KEY` 로 스코프 고정 (별도 `--project` 지정 없으면).

## 사전 요구사항

1. `docs/setup.md` 완료 (`jira doctor` 통과)
2. **`~/.config/jira-automation/convention.md` 숙지** — 제목 형식, Story Point 기준, 상태 흐름. 없으면 `/setup` 으로 생성 (`conventions/` 의 팀 컨벤션 파일을 자동 적용).

## 컨벤션 체크리스트

생성/수정 전:

- [ ] 제목이 `[파트] 작업 설명` 형식 (파트: `FE`/`BE`/`AI`/`DOCS` 등 — 팀 규약 확인)
- [ ] Story Point 가 팀 기준에 부합
- [ ] 상태 전환이 프로젝트 워크플로우를 따름

## `jira create`

```bash
jira create --summary "TITLE" \
  [--type Task|Story|Bug|Epic|Sub-task] \
  [--description "..."] \
  [--priority High|Medium|Low] \
  [--points N] \
  [--epic EPIC_KEY] \
  [--parent PARENT_KEY] \
  [--project KEY]
```

`--project` 는 기본 `.env` 의 `JIRA_PROJECT_KEY`. `--epic` 을 주면 생성과 동시에 에픽 링크까지 수행 (별도 `jira link` 불필요). `--type Sub-task` 일 때는 `--parent` 로 부모 이슈 키 지정 필수.

### 예시

```bash
# Story + points + epic 링크 한 번에
jira create \
  --summary "[BE] JWT 인증 로직 구현" \
  --description "완료 조건: 토큰 발급, 검증 미들웨어. 만료 24h" \
  --type Story --priority High --points 8 \
  --epic PROJ-12

# Epic
jira create --summary "LLM 통합" --type Epic --priority High

# Sub-task — --parent 필수
jira create --summary "[BE] 토큰 발급 함수" --type Sub-task --parent PROJ-42
```

## `jira update`

```bash
jira update <KEY> [OPTIONS]
```

| Flag | 값 |
|---|---|
| `--status` | 목표 상태 이름 (워크플로우 레이블 그대로) |
| `--assign` | `me` 또는 accountId |
| `--comment` | 코멘트 텍스트 |
| `--summary` | 제목 변경 |
| `--priority` | `High`/`Medium`/`Low` |
| `--points` | Story Points 정수 |

### 예시

```bash
jira update PROJ-42 --assign me
jira update PROJ-42 --status "진행 중" --comment "작업 시작"
jira update PROJ-42 --points 8
jira update PROJ-42 --status Done
```

## `jira link`

```bash
jira link <ISSUE_KEY> <EPIC_KEY>
```

Epic Link 필드는 `jira doctor` 가 자동 탐색한 ID 를 사용합니다. 자동 탐색이 실패하면 `.env` 에 `JIRA_EPIC_LINK_FIELD=customfield_XXXXX` 를 지정하세요.

```bash
jira link PROJ-42 PROJ-12
```

## 전체 워크플로우

이제는 `--epic` 플래그로 한 번에 가능:

```bash
# Epic 먼저
jira create --summary "LLM 통합" --type Epic
# 반환: [CREATED] PROJ-80 - LLM 통합

# Story 를 곧바로 링크하며 생성
jira create --summary "[BE] 프롬프트 파이프라인" --type Story --points 8 --epic PROJ-80
# 반환: [CREATED] PROJ-82 ... [LINKED] PROJ-82 -> PROJ-80
```

기존 이슈를 뒤에 연결할 때만 `jira link` 사용:

```bash
jira link PROJ-82 PROJ-80
```
