# Phase 2 — Multi-Bot Discord Architecture

## 목표
Discord 봇 인스턴스를 메인 봇(`재붕봇`)과 모니터링 봇(`재붕봇-모니터링`) 두 개로 분리하여, 슬래시 명령 가시성을 봇별 채널 권한으로 자연스럽게 격리한다. 그라파나 메트릭 명령은 모니터링 봇에서만 노출되고, Jira 워크플로우 명령은 메인 봇에서만 노출된다.

## 배경
- Phase 1 (커밋 직전 작업)에서 `DiscordChannel` 클래스가 `features: DiscordFeature[]` 를 주입받아 슬래시 명령과 인터랙션 핸들러를 모듈 단위로 등록하도록 리팩터링 완료.
- 단일 봇으로는 Discord 의 명령 가시성 제어가 어려움 (서버 전체에 등록되어 모든 채널 드롭다운에 노출). 봇 분리만이 코드 1회 작업으로 해결되는 깔끔한 길.
- 사용자가 별도 Discord App 을 발급함. 모니터링 봇은 `JH_Server` 의 `#로그` 채널에만 권한 부여.

## 아키텍처

```
DiscordChannel (단일 클래스, 인스턴스 다수)
├─ 메인 봇 인스턴스      (DISCORD_BOT_TOKEN)
│   features = [runtime-control, jira]
│   채널 권한: #재붕봇 #추후-수정 #자소전 #jaeboongdata 등 (기존 그대로)
│
└─ 모니터링 봇 인스턴스  (DISCORD_BOT_TOKEN_MONITORING)
    features = [runtime-control, grafana-summary]
    채널 권한: #로그 (`1500673538129002606`) 만
```

각 봇은 자기가 권한 가진 채널에서만 슬래시 명령이 보임 (Discord 가 봇 채널 권한 기반으로 자동 필터). 결과적으로:
- `#로그` 에서 `/`: `/model /effort /compact /daily /weekly /monthly` (모니터링 봇 명령)
- `#추후-수정` 에서 `/`: `/model /effort /compact /jira-sync` (메인 봇 명령)

## 구현 작업

### 1. 채널 등록 분리 (코드)

**파일: `src/channels/discord.ts`**
- 메인 봇 factory 에서 `grafana-summary` feature 생성 로직 제거
- `WEBHOOK_GRAFANA_JID` env 읽기 제거 (이제 모니터링 봇 책임)
- features 배열은 `[runtime-control, jira]` (jira 는 panelChannelId 설정 시)

**파일: `src/channels/discord-monitoring.ts` (신규 생성)**
- `registerChannel('discord-monitoring', factory)` 호출
- factory 가:
  - `DISCORD_BOT_TOKEN_MONITORING` 읽기 → 미설정 시 null 반환 (스킵)
  - `WEBHOOK_GRAFANA_JID` 읽기 → 미설정 시 null 반환 (모니터링 봇 의미 없음)
  - features = `[runtime-control, createGrafanaSummaryFeature({ grafanaJid })]`
  - `new DiscordChannel(monitoringToken, opts, features)` 반환
- `runtime-control` 모듈은 그대로 재사용 (메인/모니터링 양쪽 공유)

**파일: `src/channels/index.ts` (배럴)**
- `import './discord-monitoring.js';` 추가

**검증**:
- `npm run build` 통과
- 기동 시 두 개의 "Discord bot connected" 로그 (메인 + 모니터링)
- 각 봇이 자기 features 만 등록 (`count: 4` 메인, `count: 6` 모니터링)

### 2. `discord_main_log` 그룹 등록

`#로그` 채널을 `registered_groups` 테이블에 등록 필요:
- `jid = 'dc:1500673538129002606'`
- `folder = 'discord_main_log'`
- `name = '두잇뚜 #로그'` (또는 적절한 이름)
- `trigger_pattern = '@Andy'` (기본 트리거 — 실제로는 drop 모드라 의미 없음)
- `requires_trigger = 0`
- `is_main = 1`
- `container_config = NULL`

작업 옵션:
- (a) 봇이 처음 #로그 메시지 받을 때 자동 등록 — 현재 기본 동작인지 확인 필요
- (b) Codex 가 SQL INSERT 또는 `setRegisteredGroup` 호출하는 일회성 스크립트 작성 후 실행
- (c) 부팅 시 env 기반으로 자동 등록 (`AUTO_REGISTER_MONITORING_GROUP=1` 같은)

**선호: (b)** — 명시적이고 1회만 실행. Codex 가 `scripts/register-monitoring-group.ts` 같은 파일 만들고 `npx tsx scripts/register-monitoring-group.ts` 로 실행.

추가로 `groups/discord_main_log/` 폴더 구조 생성 필요할 수 있음:
- `CLAUDE.md` (모니터링 전용 메모리 시드)
- `inbox/`, `logs/`, `memory/`, `conversations/` 디렉토리

기존 `discord_main` 패턴 참고. `runtime-settings.json` 은 옵션 (없으면 기본값).

### 3. Sender Allowlist 업데이트

**파일: `~/.config/nanoclaw/sender-allowlist.json`**

현재 JH_Server 메인 그룹들이 drop 모드로 재환만 허용:
```json
"dc:1495097903985725672": { "allow": ["242129386109665281"], "mode": "drop" },
"dc:1495328144578707506": { "allow": ["242129386109665281"], "mode": "drop" },
"dc:1495329184149671966": { "allow": ["242129386109665281"], "mode": "drop" }
```

`#로그` 도 동일 패턴 추가:
```json
"dc:1500673538129002606": { "allow": ["242129386109665281"], "mode": "drop" }
```

### 4. .env 업데이트 (Claude 가 이미 수행)

```
DISCORD_BOT_TOKEN_MONITORING=<masked>
WEBHOOK_GRAFANA_JID=dc:1500673538129002606
```

기존 `DISCORD_BOT_TOKEN`, `DISCORD_JIRA_PANEL_CHANNEL_ID` 그대로 유지. `WEBHOOK_TOKEN` 은 추후 Grafana 웹훅 라우팅 본격 활성화 시 추가 (현재 슬래시 명령만 활성화하면 충분).

## 사용자 액션 (코드 작업 외)

- **메인 봇 권한 정리** (Discord 서버 설정):
  - `JH_Server` 의 `#로그` 채널 권한에서 `재붕봇` 의 액세스 거부 (또는 채널을 메인 봇에 안 보이게)
  - 모니터링 봇 권한은 이미 `#로그` 만 허용 상태로 초대했으므로 OK
- **검증 시점**:
  - 슬래시 명령 분리: `#로그` 에서 `/` 입력 → `/jira-sync` 안 보여야 함, `/daily` 보여야 함
  - 반대로 `#추후-수정` 에서 `/` → `/daily` 안 보여야 함, `/jira-sync` 보여야 함

## 검증 체크리스트

- [ ] `npm run build` 통과
- [ ] `systemctl --user restart nanoclaw` 후 두 봇 "connected" 로그
- [ ] 각 봇 슬래시 명령 카운트 (메인=4, 모니터링=6)
- [ ] `registered_groups` 테이블에 `discord_main_log` 엔트리 존재
- [ ] `~/.config/nanoclaw/sender-allowlist.json` 에 `#로그` 엔트리 추가
- [ ] `groups/discord_main_log/` 폴더 구조 생성 (`CLAUDE.md`, `memory/`, `inbox/`, `logs/`)
- [ ] `#로그` 에서 재환이 봇 멘션 → 응답 동작
- [ ] `#로그` 외 다른 채널 (예: 본인 DM) 에서 모니터링 봇이 메시지 받아도 drop (메모리 보호)
- [ ] Discord UI 상 명령 가시성 격리 검증

## 위험 / 주의

- **OneCLI agent 매핑**: 기존 NanoClaw 가 `dc:<channelId>` 마다 OneCLI agent 를 ensure 함. `#로그` 채널에 대해서도 자동 생성될 것 — 별다른 작업 불필요 예상. 부팅 로그에서 `OneCLI agent ensured ... discord-main-log` 확인.
- **컨테이너 마운트 보안**: 메모리에 적힌 "JH-Server 메인 그룹은 docker.sock + SSH 키 패스스루" 패턴 — `#로그` 모니터링 봇은 **단순 알림 수신/요약/조회 위주**. docker.sock/SSH 권한 부여하지 **않음**. 사용자가 추후 호스트 작업 자동화까지 원하면 그때 결정.
- **명령 충돌 없음**: 같은 길드에 두 봇이 동시에 `/model` 등록해도 Discord 가 봇 별로 각자 표시. 채널 권한이 있는 봇의 명령만 보이므로 사용자가 헷갈릴 일 없음.

## 위임 단위

| 단위 | 담당 | 비고 |
|---|---|---|
| .env 업데이트 | Claude (완료) | — |
| 플랜 작성 | Claude (이 문서) | — |
| Discord App 생성 + 초대 | 사용자 (완료) | 토큰 공유 받음 |
| 채널 권한 정리 | 사용자 (대기) | Discord UI 작업 |
| 코드 변경 (#1) | Codex | discord.ts + discord-monitoring.ts + index.ts 배럴 |
| 그룹 등록 스크립트 (#2) | Codex | scripts/register-monitoring-group.ts + 실행 |
| 폴더 구조 생성 (#2) | Codex | groups/discord_main_log/* |
| Sender allowlist (#3) | Codex | ~/.config/nanoclaw/sender-allowlist.json |
| 빌드 검증 | Codex | `npm run build` |
| 재시작 + 로그 검증 | Claude | `systemctl --user restart` + journalctl |
| Discord 동작 검증 | 사용자 | `/jira-sync`, `/daily` 가시성 확인 |

## 후속 (Phase 2 외)

Webhook 본격 활성화는 별도 작업:
- `WEBHOOK_TOKEN` 발급 + `.env` 추가
- Grafana 알림 contact point 설정
- 인바운드 URL 노출 (포트 / 리버스 프록시)

이번 Phase 2 는 **슬래시 명령 분리 + 메모리 격리** 까지만.
