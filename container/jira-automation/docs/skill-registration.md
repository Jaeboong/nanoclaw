# Claude Code / Codex 스킬로 등록하기

> **가장 빠른 길:** 레포 루트에서 Claude Code 를 열고 `/setup` 을 실행하면 이 문서의 모든 단계를 자동으로 수행합니다. 아래는 `/setup` 이 내부적으로 하는 일의 설명이자, 수동으로 처리할 때 참고 자료입니다.

`pipx install` 은 `jira` 바이너리를 PATH 에 넣을 뿐, 에이전트가 "이 리포지토리를 스킬로 인식" 하게 해주지는 않습니다. 스킬로 자동 로드되려면 `SKILL.md` 가 에이전트가 탐색하는 경로에 있어야 합니다.

## Claude Code

Claude Code 는 두 위치에서 스킬을 찾습니다:

1. **전역** — `~/.claude/skills/<name>/SKILL.md`
2. **프로젝트별** — `<project>/.claude/skills/<name>/SKILL.md`

### 권장: 심링크

리포지토리를 한 번 클론한 뒤 심링크로 걸면 업그레이드(`git pull`) 가 즉시 반영됩니다.

```bash
git clone https://github.com/Jaeboong/Jira_automation ~/src/Jira_automation
mkdir -p ~/.claude/skills
ln -s ~/src/Jira_automation ~/.claude/skills/jira
```

이후 Claude Code 세션에서 "지라 이슈 검색해줘" 같이 요청하면 `SKILL.md` 매처가 발동하고, `SKILL.md` 가 `CLAUDE.md` + `docs/` 로 라우팅합니다.

### 대안: 복사

심링크가 불편하면 복사해도 됩니다. 대신 업그레이드는 수동.

```bash
mkdir -p ~/.claude/skills/jira
cp -r SKILL.md CLAUDE.md AGENTS.md README.md docs conventions ~/.claude/skills/jira/
```

## Codex

Codex 는 `AGENTS.md` 를 CWD 기준으로 자동 로드합니다. 스킬 디렉토리 개념이 별도로 없으므로, 해당 프로젝트 루트에 이 리포지토리의 `AGENTS.md` 를 두거나 (복사 또는 심링크) 작업 디렉토리에서 `AGENTS.md` 가 발견 가능한 위치로 조정하세요.

## `.env` 는 어디 두나

`jira` 바이너리는 아래 순서로 `.env` 를 찾습니다 (상세는 `docs/setup.md`):

1. `$JIRA_CONFIG_DIR/.env`
2. `./.env`
3. `~/.config/jira-automation/.env`

**스킬로 등록했을 때는 3번을 권장합니다** — 에이전트 세션의 CWD 가 어느 프로젝트냐에 상관없이 한 곳에서 관리됩니다.

```bash
mkdir -p ~/.config/jira-automation
cp ~/.claude/skills/jira/.env.example ~/.config/jira-automation/.env
# 편집해서 본인 값 채움
```

## 확인

```bash
jira doctor
# [CONFIG] env file = ~/.config/jira-automation/.env 등이 찍히면 OK
```

이후 새 Claude Code 세션에서 "지라" 언급 → 스킬 매칭 → `SKILL.md` 로드 → `jira --help` / `jira doctor` 수행이 cold-start 체크리스트입니다.
