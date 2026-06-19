# sync-observer 코드베이스 분석 보고서

> 작성 기준: `main` 브랜치, 커밋 `c41c919` (2026-06-19). 본 보고서는 **8개 서브시스템 맵**과 **42개 후보에 대한 적대적(adversarial) 검증 판정**을 종합한 것이며, 검증 판정이 맵의 추정과 충돌할 경우 **검증 판정을 우선**한다. (생성: 동적 워크플로우 54 에이전트.)

---

## 1. 결론 요약 (TL;DR)

- **핵심 제품은 "로컬 hermes 에이전트 활동 모니터링 도구"다.** 3계층 파이프라인: ① hermes 플러그인(`hermes-plugin/`, Python) → ② 로컬 sqlite 컬렉터(`server/src/collector/`, `127.0.0.1:8787`) → ③ 모니터 UI(`src/features/monitor/` + `/monitor` 라우트). 세 계층 모두 피벗 이후 새로 만들어진 코드(`feat(monitor)`/`test(monitor)` 커밋).

- **레거시는 원래 제품 "SyncSpace 실시간 협업 + A2A 에이전트 플랫폼"이다.** Yjs 채팅/문서, 미션 뷰, 원격 에이전트 등록, Postgres 백엔드, A2A 서버, 잡 워커가 그대로 남아 **여전히 별도 엔트리포인트로 wired** 되어 있다(`server/src/server.ts`, 라우터 `/w/:workspaceId` 트리).

- **둘의 관계는 "미완성 피벗"이다.** 모니터는 레거시와 **거의 완전히 독립**(컬렉터 백엔드 = `CLEAN_INDEPENDENT`, 프론트 = leaf 유틸 1개만 결합). 하지만 인프라/문서/루트 스크립트는 미갱신 — 루트 `dev`/`dev:full`은 컬렉터가 아니라 레거시 서버를 부팅한다.

- **진짜 정리할 것이 있다.** `CONFIRMED_DEAD` 확정 파일 30+개: 라우터 고아 페이지 3개, read-only 피벗으로 죽은 에디터/뮤테이션 5개, AgentRail 루트의 **죽은 에이전트 서브트리 16개**, 죽은 백엔드 래퍼 4개, Supabase SQL 3개, 통째 스테일한 `AI_docs/` 25파일.

- **단, 일부 후보는 죽지 않았다.** `railway.json`/`railway.worker.toml`/`Dockerfile.web` = `LEGACY_BUT_LIVE`(실제 배포 연결), `Caddyfile`/`vercel.json` = `SHARED_USED_BY_MONITOR`(같은 SPA 번들로 `/monitor`도 서빙). "레거시처럼 보이지만 지우면 깨진다."

- **유일한 모니터→레거시 코드 결합은 사소하다.** 모니터 3개 파일이 `src/features/missions/missionTime.ts`(의존성 0인 순수 날짜 포맷)를 임포트. 이것만 `src/shared/`로 옮기면 모니터는 완전 독립.

---

## 2. 핵심: 로컬 에이전트 모니터링 도구

목적: 로컬 NousResearch hermes 에이전트의 모든 툴 호출(읽기/쓰기/검색/터미널)을 **관찰 + 개입**. 단일 사용자 localhost 도구, 인증 없음.

### 아키텍처 3계층

```
[hermes 에이전트 프로세스]
        │ 플러그인 in-process 훅 (pre_tool_call / post_tool_call / subagent_*)
        ▼
① hermes-plugin/  (Python, 순수 stdlib, 패키지명 syncspace_monitor)
        │  POST /ingest/events   (fire-and-forget, 백그라운드 데몬 스레드)
        │  GET  /control/pending (M5 수동 인터럽트 폴링)
        ▼
② server/src/collector/  (node:sqlite, 127.0.0.1:8787)
        │  GET /api/stream(SSE) · /api/events · /api/sessions · /api/tree · /api/interventions
        │  POST /control/rules · /control/interrupt
        ▼
③ src/features/monitor/ + /monitor 라우트  (React, Vite SPA)
```

### ① hermes 플러그인 (`hermes-plugin/`)

**엔트리포인트:** `plugin.yaml`(매니페스트) + `__init__.py`의 `register(ctx)`가 `Monitor` 싱글턴 생성, 4개 훅 바인딩. 모든 훅은 **fail-open**(예외 삼킴)이라 에이전트 루프를 깨지 않음.

| 핵심 파일 | 역할 |
|---|---|
| `syncspace_monitor/hooks.py` | `Monitor` — 룰 평가, pre-block, M5 인터럽트 폴링의 런타임 중심 |
| `syncspace_monitor/events.py` | 훅 kwargs → PIVOT §3 정규화 이벤트 dict (action 매핑·경로 추출·터미널 파서) |
| `syncspace_monitor/rules.py` | 경로 allow/deny 엔진 — glob, realpath/NFC, deny-overrides, mtime 핫리로드 |
| `syncspace_monitor/emit.py` | `EventEmitter` — 백그라운드 큐 + urllib POST, 컬렉터 다운 시 graceful-skip |
| `syncspace_monitor/config.py` | env Config; `/ingest/events`·`/control/pending` (컬렉터 라우트와 일치) |

> **계약:** `events.py` ↔ 컬렉터 `activityEvent.ts`(zod) ↔ 프론트 `shared/types/activityEvent.ts` 셋은 **하나의 버전드 계약**으로 다뤄야 한다.

### ② 컬렉터 백엔드 (`server/src/collector/`, 12파일)

**엔트리포인트:** `collector/main.ts` → `createCollectorServer()`. npm `dev:collector`/`start:collector`. `DATABASE_URL` unset이어도 부팅(pg 미사용). 수집 → `EventHub`(200-event 링버퍼) SSE 팬아웃 → sqlite(WAL, `INSERT OR IGNORE` dedup). `host`는 `127.0.0.1` 하드코딩.

핵심 파일: `main.ts`·`server.ts`·`config.ts`·`store.ts`·`routes.ts`·`activityEvent.ts`(계약 권위)·`hub.ts`·`rulesFile.ts`·`tree.ts` + `__tests__/{store,routes,tree}.test.ts`.

> **보안:** 상태변경 라우트 = loopback + Origin allow-list, `/control/*` = 추가로 `X-SyncSpace-Local: 1` 헤더(CSRF 방어). `GET /control/pending`은 consume-once mutate라 같은 가드.

### ③ 모니터 UI (`src/features/monitor/` 15파일 + `src/pages/monitor/`)

**엔트리포인트:** 라우터 line 24에서 `/monitor`를 **인증 셸 밖** 최상위로 마운트. `MonitorPage.tsx`가 `useActivityStream()`를 **한 번** 호출해 단일 SSE 구독을 열고 파일트리·라이브피드가 공유. `IdeShell`이 6탭(Dashboard·LiveEventFeed·Timeline·InterventionsLog·RulesManager·ManualInterrupt). 모든 백엔드 I/O는 `collectorClient.ts`(기본 `127.0.0.1:8787`).

> **함정:** `shared/types/engineeringEvents.ts`는 `activityEvent.ts` 옆에 있지만 **모니터가 안 씀** — 레거시 missions·a2a 전용(피벗 이전 A2A 계약).

---

## 3. 레거시: SyncSpace 협업 앱 (여전히 wired)

피벗 이전 제품: Yjs 채팅/Tiptap 문서, 채널/문서, presence, 미션 타임라인, 에이전트 디렉터리, 원격 에이전트(A2A) 자가 등록, Postgres, 잡 워커. **삭제되지 않고 read-only "관전(spectator)" 모드로 용도 변경** — 사람은 구경, 에이전트가 A2A/WS로 편집.

| 서브시스템 | 엔트리포인트 | 상태 |
|---|---|---|
| 레거시 백엔드(REST/WS/A2A/Yjs/PG) | `server/src/server.ts` (npm `dev`/`start`, :1234) | **wired(live)** |
| 잡 워커 | `server/src/workers/index.ts` (npm `worker`) | **wired(live)** |
| DB 마이그/시드 CLI | `server/src/db/{migrate,seed,…}.ts` (npm `db:*`) | **wired(CLI)** |
| 레거시 프론트(홈/로그인/계약) | 라우터 최상위 `/`,`/login`,`/api-contract` | **wired(live)** |
| 워크스페이스 셸 + 협업 작업면 | `/w/:id` 트리(`WorkspaceShell`/`WorkspaceSplitPage`) | **wired(관전 모드)** |
| 미션 뷰 | `src/features/missions/**` (`/w/:id/mission/:ctxId`) | **wired(live)** |

> 백엔드는 **3개 독립 프로세스 엔트리포인트**(`server.ts` 레거시 / `workers/index.ts` / `collector/main.ts` 모니터)를 하나의 `server/src` 트리에서 공유. (`BOUNDARY:two-entrypoints` 검증 = 확정)

---

## 4. 경계 분석

### ① 컬렉터 백엔드 ↔ 레거시 → `CLEAN_INDEPENDENT` ✅
12개 컬렉터 파일에서 금지 임포트(`../db`,`pg`,`../a2a`,`../realtime`,`../agents`,`../workers`,`embedded-postgres`,`yjs`) **전부 ZERO**. 유일한 레거시 연결은 컴파일 타임 소거되는 타입 한 줄(`http/context.ts`의 `AuthContext` 타입; 런타임 의존성 없음).

### ② 모니터 프론트엔드 ↔ 레거시 → `LEGACY_BUT_LIVE` ⚠️(사소)
3개 파일이 레거시 missions를 임포트:
- `monitor/components/Dashboard.tsx:4`, `activityDisplay.tsx:7`, `InterventionsLog.tsx:5` → 모두 `'../../missions/missionTime'`의 `relativeTime`/`formatEventTime`.

심각도 낮음 — `missionTime.ts`는 자체 임포트 0인 leaf(순수 ko-KR 날짜 포맷). 모니터 15파일에서 레거시 스토어/api/다른 피처 결합은 **0건**, 오직 이 하나.

### 공유(SHARED) — 레거시처럼 보이나 모니터도 사용, 삭제 금지
`server/src/http/{router,context,response,errors}.ts`, `server/src/utils/logger.ts`, `src/shared/types/env.ts`, `src/features/missions/missionTime.ts`, `src/main.tsx`/`app/App.tsx`/`app/router/*`, `NotFoundPage.tsx`, 빌드 툴링(`vite.config.ts`/`tsconfig.json`/`index.html`/`package.json`).

---

## 5. 잔여/죽은 파일 (검증됨)

**`CONFIRMED_DEAD`만 삭제 후보**. `LEGACY_BUT_LIVE`/`SHARED_USED_BY_MONITOR`는 삭제 금지.

### 5.1 CONFIRMED_DEAD — 삭제 후보

**프론트 라우터 고아 페이지**
- `src/pages/workspace/ChannelPage.tsx` — 참조 0(라우트는 `WorkspaceSplitPage` 사용)
- `src/pages/workspace/DocumentPage.tsx` — 참조 0
- `src/pages/workspace/WorkspaceOverviewPage.tsx` — 참조 0(UI_REDESIGN_SPEC조차 데드코드로 자칭) + 동반 CSS `.workspace-overview`

**read-only 전환으로 죽은 에디터/뮤테이션**
- `src/features/editor/components/EditorToolbar.tsx` (+ `.editor-toolbar*` CSS, `editorUiStore`의 미사용 플래그)
- `src/features/channel/queries/useCreateChannelMutation.ts`
- `src/features/documents/queries/useCreateDocumentMutation.ts`
- `src/features/workspace/queries/useDeleteWorkspaceMutation.ts`
- `src/shared/stores/editorUiStore.ts` — 임포터 0

**죽은 에이전트 디렉터리 서브트리 16개 (AgentRail/TaskDetailDrawer 루트)** — `AgentRail.tsx` 임포터 0(.workflow 문서가 "AgentRail removal" 명시):
`agents/components/{AgentRail,TaskDetailDrawer,AgentTaskList,ArtifactViewer,AgentStatusBadge}.tsx`, `agents/queries/{useAgentTasksQuery,useTaskDetailQuery}.ts`, `agents/mutations/useCancelTaskMutation.ts`, `agents/taskContent.ts`, `remote-agents/components/{RemoteAgentDirectory,RemoteAgentRegisterForm}.tsx`, `remote-agents/mutations/{useRegisterRemoteAgent,useVerifyRemoteAgent,useHealthCheck,useDeleteRemoteAgent}Mutation.ts`, `remote-agents/remoteAgentDisplay.ts`.

> ⚠️ **agents/remote-agents 피처가 통째로 죽은 건 아니다.** 채팅 `MessageComposer`가 `useAgentsQuery`·`useInvokeAgentMutation`·`MentionSuggestions`·`useRemoteAgentsQuery` 등을 @멘션에 **여전히 사용** — 이 6개 live 파일은 삭제 금지. 위 16개만 죽었다.

**백엔드 죽은 래퍼/스텁**
- `server/src/agents/mentions.ts` (live는 `mentionDispatcher.ts`)
- `server/src/realtime/awareness.ts` (런타임 헬퍼 임포터 0; 타입은 `types/contracts.ts`에서 옴)
- `server/src/routes/chatRoute.ts`, `server/src/routes/docRoute.ts` (WS 서버가 우회)

**인프라/플러그인 아티팩트**
- `hermes-plugin/scripts/g0_captured_payload.json` — 내용을 읽는 코드 없음(재생성 가능; live seal은 `test_g0_seal.py` 인라인)
- `supabase/schema.sql`, `supabase/rls.sql`, `supabase/seed.sql` — 참조 0(live DB는 `server/migrations/*.sql`)
  - 동반: `.github/workflows/backend.yml`의 스테일 `supabase/**` path 트리거 정리 권장

**문서(통째 스테일)**
- `AI_docs/` 25파일 — 존재하지 않는 `apps/web`+Supabase 모노레포 명세, 현 코드와 불일치(삭제는 인간 판단)
- `docs/UI_REDESIGN_SPEC.md` — 레거시 화면만, 존재하지 않는 절대경로 참조

### 5.2 LEGACY_BUT_LIVE — 삭제 금지(레거시지만 연결됨)
- `railway.json` — Railway 기본 config-as-code, `railway.api.toml`보다 최신, live 배포 구동
- `railway.worker.toml` — live 워커 배포 config
- `Dockerfile.web` — `railway.web.toml`이 참조
- `railway.api.toml`/`railway.web.toml` — 외부 Railway 와이어 가능성, **파괴 전 배포 토폴로지 확인** 필요(보수적 보류)

### 5.3 SHARED_USED_BY_MONITOR — 삭제 금지(모니터도 사용)
- `Caddyfile` — `file_server`가 전체 SPA(`/monitor` 포함) 서빙
- `vercel.json` — `verify:frontend` 빌드가 `/monitor` 포함, `/monitor` deep-link rewrite 제공

### 5.4 UNCERTAIN
- `README.md` — 코드가 아님. `.gitignore`가 README만 화이트리스트(의도적 보존). **삭제가 아니라 재작성 대상.**

---

## 6. 스테일 문서 (3세대 층화)

1. **(가장 오래됨) `AI_docs/` 25파일** — Supabase MVP 스캐폴딩, "Not started", 현 코드와 모순.
2. **(중간) `README.md`, `docs/USER_FLOWS.md`, `docs/UI_REDESIGN_SPEC.md`, `docs/migration/*`, `.workflow/mission-view-*`** — 성숙한 협업앱 + Railway 마이그레이션, **모니터 피벗 이전**.
3. **(현재) `docs/SCREEN_COMPOSITION.md`, `hermes-plugin/scripts/G0.md`** — 모니터를 다루는 유일한 2개 문서.

핵심 불일치:
- **`README.md`가 현 핵심을 통째로 누락** — 제품을 "SyncSpace 협업 워크벤치"로만 규정, hermes 모니터/`/monitor`/컬렉터를 단 한 번도 언급 안 함. **첫 독자를 오도.**
- **`docs/SCREEN_COMPOSITION.md`가 권위 있는 현황 지도** — 앱을 "협업앱 + 로컬 모니터 2영역"으로 정확히 매핑.
- `G0.md`가 존재하지 않는 `docs/HERMES_OPERATION.md §8`을 참조(dangling).
- 레거시 "missions"(협업앱 미션 뷰)와 모니터(`/monitor`)를 혼동 금지 — 별개.

---

## 7. 정리 권고 (제안만; 파괴적 액션은 미실행)

| 단계 | 내용 | 위험도 | 선결 |
|---|---|---|---|
| **0** | `missionTime.ts` → `src/shared/`로 이동(임포트 3곳 재지정) | 낮음 | — |
| **1** | `CONFIRMED_DEAD` 30+개 제거(서브트리는 함께) | 낮음 | 빌드 검증 |
| **2** | `supabase/*.sql` 3개 + CI path 트리거 정리 | 낮음 | — |
| **3** | `README.md` 재작성(모니터 반영), 스테일 문서 표기 | 낮음~중간 | — |
| **4** | 레거시 협업 앱 전체 격리/제거 | **높음** | 단계 0 + 비즈니스 결정 |

**단계 0 → 단계 1**이 가장 안전하고 효과 큰 시작점: 모니터가 완전 독립되고, 검증된 죽은 파일 30+개가 사라지며, 레거시는 별도 엔트리포인트로 격리돼 있어 그대로 둬도 무방.

- **단계 1 주의:** 에이전트 서브트리 16개는 **한 번에** 삭제(부분 삭제 시 dangling import). `MessageComposer`가 쓰는 6개 live 파일은 절대 건드리지 말 것. 삭제 후 `pnpm run verify:frontend` + `pnpm --filter server build`로 타입체크 재확인 필수.
- **단계 4 주의:** 레거시는 현재 live이며 외부 배포가 가리킬 수 있음. `vercel.json`/`Caddyfile`/`railway.*`은 배포 토폴로지 확인 전까지 건드리지 말 것. 백엔드 제거 시 `http/*`·`utils/logger.ts`는 컬렉터 공유이므로 보존.

---

> 근거 파일: `src/app/router/router.tsx`, `src/{features,pages,shared}/**`, `server/src/**`, `hermes-plugin/**`, 루트 인프라/문서. 본 레포 `.gitignore`는 `*.md`를 무시(README만 화이트리스트) — 이 문서 추적 시 `git add -f docs/CODEBASE_ANALYSIS.md`.
