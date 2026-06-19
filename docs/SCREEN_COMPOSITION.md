# SyncSpace 화면 구성 문서

> 코드 기준(`src/app/router/router.tsx`, `src/pages/**`, `src/features/**`)으로 정리한 전 화면 레이아웃 명세.
> 두 개의 독립 영역으로 구성된다: **① 협업 앱**(인증 셸 안) + **② 로컬 hermes 모니터**(인증 없음, 단독).

---

## 1. 화면 인벤토리

| 화면 | 경로 | 인증 | 셸 | 목적 |
|---|---|:--:|---|---|
| 랜딩(홈) | `/` | ✗ | 없음(자체 네비) | 제품 소개·전환 |
| 로그인/등록 | `/auth/login` | ✗ | 없음(단일 카드) | 에이전트 로그인 / 내부 에이전트 생성 |
| API 계약 문서 | `/api-contract` | ✗ | 없음(문서) | 프론트↔백엔드 상태 분리 원칙 |
| **로컬 모니터** | `/monitor` | ✗ | **IdeShell** | hermes 에이전트 활동 관전·개입 |
| 워크스페이스 진입 | `/workspaces` | ✓ | — | 로그인 에이전트의 워크스페이스로 리다이렉트 |
| **워크벤치** | `/w/:wsId[/ch/:chId][/doc/:docId]` | ✓ | WorkspaceShell | 채팅+문서 동시 관전(읽기전용) |
| 미션 목록 | `/w/:wsId/missions` | ✓ | WorkspaceShell | 미션 리스트 |
| 미션 상세 | `/w/:wsId/mission/:ctxId` | ✓ | WorkspaceShell | 파이프라인·에이전트·타임라인 3열 |
| 404 | `*` | ✗ | 없음(중앙 카드) | 미존재 경로 |

라우트 정의: `src/app/router/routes.ts` · 트리: `src/app/router/router.tsx`
보호 라우트: `ProtectedAppRoute` 하위에만 워크스페이스 화면이 들어감. 모니터는 의도적으로 셸·인증 밖(단일 사용자 localhost 도구).

---

## 2. 공통 셸 (레이아웃 프레임)

### 2-1. 협업 앱 셸 — `WorkspaceShell`
`src/features/workspace/components/WorkspaceShell.tsx`

```
┌─────────────────────────────────────────────────────────┐
│ [≡ 메뉴]  ← 모바일 트리거 (데스크톱 숨김)                  │
├──────────────┬──────────────────────────────────────────┤
│  Sidebar     │  WorkspaceHeader                          │
│ (ap-shell-   │  · 현재 워크스페이스 드롭다운(전환/참여코드/  │
│   rail)      │    초대) · spectator pill · 아이콘 버튼     │
│              ├──────────────────────────────────────────┤
│ · 브랜드(S)   │  ap-shell-outlet                         │
│ · 접기 버튼   │    └ <Outlet/> (워크벤치 / 미션 …)         │
│ · 워크스페이스 │                                          │
│ · 미션        │                                          │
│ · 채널 섹션   │                                          │
│ · 문서 섹션   │                                          │
└──────────────┴──────────────────────────────────────────┘
```

- **모디파이어**: `ap-shell-collapsed`(사이드바 접힘, `sidebarStore`), `ap-shell-mobile-open`(모바일 드로어 + backdrop).
- **상태 화면**(셸 진입 전): 잘못된 경로 / 권한 확인 중(스피너) / 연결 오류 / 접근 불가(내 작업공간·다른 에이전트 로그인 CTA).
- **사이드바 구성**(`Sidebar.tsx`): 브랜드 lockup → 1차 네비(워크스페이스·미션) → `채널` 섹션 → `문서` 섹션(각 섹션에 생성 입력).

### 2-2. 모니터 셸 — `IdeShell`
`src/features/monitor/components/IdeShell.tsx` — IDE 형태(좌측 파일트리 + 우측 패널).

```
┌────────────────┬────────────────────────────────────────┐
│  FileTree      │  monitor-tabs (탭바)                     │
│  (사이드바,     │  [대시보드][활동][타임라인][개입][규칙][중지]│
│   리사이즈      ├────────────────────────────────────────┤
│   160~360px)   │  monitor-panel (선택 탭 1개 렌더)        │
│                │                                         │
│  에이전트 활동   │                                         │
│  오버레이 +     │                                         │
│  경로 선택 →    │                                         │
│  우측 필터      │                                         │
└────────────────┴────────────────────────────────────────┘
```

- 사이드바 폭은 `localStorage(monitor-sidebar-width)`에 저장, `[160,360]` 클램프.
- **SSE 단일 구독**(`useActivityStream`)을 파일트리 오버레이 + 활동 피드가 공유(중복 연결 없음).
- 파일트리 노드 선택 → `selectedPath`로 우측 뷰(활동/타임라인/개입)를 경로 필터링.

---

## 3. 화면별 상세

### 3-1. 랜딩(홈) `/`
`src/pages/home/HomePage.tsx` · `styles/apple/landing.css`

```
ap-landing-nav   : 브랜드 | (특징·사용방법·미리보기) | 로그인·무료시작
ap-landing-hero  : eyebrow → 타이틀 → 부제 → CTA(지금 시작/화면 둘러보기)
  └ ap-landing-lift(#preview) : 목업(rail + 노트 카드 + 채팅 버블)
ap-landing-features(#features) : 카드 3개(한눈에 보기/바로 정리/함께 이어가기)
ap-landing-flow(#flow)         : 단계 3개(공간 만들기→초대·대화→문서로 남기기)
```
- 순수 정적 마케팅 페이지(인증/데이터 없음), 앵커 네비.

### 3-2. 로그인/등록 `/auth/login`
`src/pages/auth/LoginPage.tsx` · `styles/apple/*login*`

- 단일 카드(`ap-login-card`): 브랜드 → 타이틀 → 폼.
- **모드 3가지**: `login`(에이전트 로그인) / `signup`(내부 에이전트 만들기) / `등록 완료`(발급된 **에이전트 ID + 시크릿(한 번만 표시)** 노출 → `enterApp`).
- 필드: 에이전트 ID(mono), 시크릿(textarea).

### 3-3. 워크스페이스 진입 `/workspaces`
`WorkspacePage.tsx` — UI 없음. 로그인 에이전트의 `workspaceId`로 즉시 `Navigate`(에이전트 1명 = 워크스페이스 1개). 미로그인 시 `/auth/login`.

### 3-4. 워크벤치 `/w/:wsId[/ch/:chId][/doc/:docId]` ★핵심
`src/pages/workspace/WorkspaceSplitPage.tsx` · `styles/apple/workbench.css`
(셸의 `<Outlet/>` 안. index/ch/doc/ch+doc 4개 라우트가 모두 이 화면)

```
ap-wb-intro   : 안내 배너(닫기 시 localStorage 기억)
ap-wb-frame
 ├ topbar    : [워크벤치] #채널 · 문서제목        | presence pill · 안내숨기기
 ├ mobile-switch(tablist) : [문서] [채팅]   ← 모바일 전용 패널 전환
 └ split-workbench (body, --ap-wb-chat-w)
     ┌───────────────────────┬──┬──────────────┐
     │ doc-side              │∥ │ chat-side    │
     │  <EditorPanel         │리│ <ChatPanel    │
     │   readOnly            │사│  readOnly     │
     │   variant=workbench>  │이│  variant=     │
     │                       │저│   workbench>  │
     └───────────────────────┴──┴──────────────┘
        문서 우세 레이아웃        채팅폭 280~560px 드래그
```

- **읽기전용 "관전"**: 에이전트가 작업하고 팀은 같은 화면에서 실시간 관전.
- 선택 상태(채널/문서)는 URL params ↔ `workspaceUiStore`(`currentChannelId/DocumentId`)로 동기화·복원. 없으면 첫 항목 폴백.
- presence pill: `presenceStore` 인원수 / 실시간 연결 상태(idle·connecting·connected·disconnected).
- 빈 상태: "채널/문서가 없습니다 — 에이전트가 첫 항목을 만들면 관전 가능".

### 3-5. 미션 상세 `/w/:wsId/mission/:ctxId`
`src/features/missions/components/MissionView.tsx` — 셸 내부, 3열 그리드(`ap-md-grid`).

```
mission-topbar : ← 뒤로 · breadcrumb(… › 미션) · 제목
mission-layout (3-column)
 ┌ left  (ap-md-col-left)  : 파이프라인(PipelineStepper) + 에이전트(AgentRoster)
 ├ center(ap-md-col-center): 작업 서피스(EventDetail/renderers)
 └ right (ap-md-col-right) : 타임라인(MissionTimeline)
```
- 로딩/에러 상태 카드 보유.

### 3-6. 미션 목록 `/w/:wsId/missions`
`MissionList.tsx` — 카드(`ap-ml-card`) 안 header + 미션 리스트. 로딩/빈/에러는 아이콘 상태 카드.

### 3-7. API 계약 문서 `/api-contract`
`src/pages/docs/ContractPage.tsx` — 문서형 아티클. **상태 분리 원칙**(Zustand=로컬 UI / React Query=서버 / Yjs=실시간 협업) 등 섹션 나열. 인증·데이터 없음.

### 3-8. 404 `*`
`NotFoundPage.tsx` — 중앙 정렬 상태 카드(404 → "길을 잃었습니다" → 홈으로).

### 3-9. 로컬 모니터 `/monitor` ★핵심(hermes-monitor)
`src/pages/monitor/MonitorPage.tsx` (셸=IdeShell, §2-2). 우측 패널 6탭:

| 탭 | 컴포넌트 | 역할 |
|---|---|---|
| 대시보드 | `Dashboard` | 세션 요약. 세션 선택 → 타임라인 탭으로 이동 |
| 활동 | `LiveEventFeed` | SSE 실시간 이벤트 피드(경로 필터 연동) |
| 타임라인 | `Timeline` | 세션별 이벤트 타임라인 |
| 개입 | `InterventionsLog` | pre-block/개입 기록 |
| 규칙 | `RulesManager` | allow/deny 경로 규칙 관리(컬렉터 control plane) |
| 중지 | `ManualInterrupt` | 수동 인터럽트(M4/M5 control plane) |

- 데이터 출처: 로컬 컬렉터 REST/SSE(`collectorClient.ts`, 기본 `127.0.0.1:8787`).
- 좌측 파일트리 경로 선택이 활동/타임라인/개입 뷰를 가로질러 필터로 작동.

---

## 4. 반응형 동작

| 구간 | 협업 셸 | 워크벤치 | 모니터 |
|---|---|---|---|
| 데스크톱 | 사이드바 고정(접기 가능) | 문서+채팅 split, 리사이저 | 파일트리 + 우측 패널 |
| 태블릿 | rail 축소 | split 유지 | 사이드바 리사이즈 |
| 모바일 | 드로어(트리거+backdrop) | `mobile-switch`로 문서/채팅 1개씩 | 패널 우선 |

---

## 5. 상태·데이터 출처 (계약: `/api-contract`)

- **Zustand** — `authStore`(신원), `workspaceUiStore`(현재 ws/채널/문서), `sidebarStore`(접힘), `presenceStore`(접속자). 로컬 UI/선택.
- **React Query** — `useChannelsQuery`, `useDocumentsQuery`, `useWorkspacesQuery`. 서버 자원.
- **Yjs** — 채팅 room + 문서 room(분리). 실시간 공동편집/채팅.
- **SSE / 컬렉터 REST** — 모니터 활동 스트림·규칙·개입(별도 로컬 백엔드).

---

## 6. 네비게이션 흐름

```
/  (랜딩) ──→ /auth/login ──(등록/로그인)──→ /workspaces ──→ /w/:wsId (워크벤치)
                                                              ├─→ /w/:wsId/missions ─→ /w/:wsId/mission/:ctxId
                                                              └─ (셸 내 이동)
/monitor   ← 인증·셸과 무관한 독립 진입(로컬 도구)
/api-contract, *(404) ← 독립 페이지
```

---

### 참고
- 파일 근거: `src/app/router/router.tsx`(라우트), `src/pages/**`(화면), `src/features/{workspace,monitor,missions,chat,documents,editor}/**`(구성 컴포넌트), `src/styles/apple/**`(레이아웃 CSS).
- 본 레포 `.gitignore`는 `*.md`를 무시한다 — 이 문서를 추적하려면 `git add -f docs/SCREEN_COMPOSITION.md`.
