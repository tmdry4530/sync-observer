# Migration Baseline — full-agent-a2a-railway

문서 버전: 2026-06-09
브랜치: `migration/full-agent-a2a-railway` (base: `main`)

이 문서는 SyncSpace 1단계 완성형(A2A + Railway) 마이그레이션의 기준선이다. 작업 전 현재
동작/구조/검증 상태를 고정해 두고, 각 Phase가 회귀 없이 진행되는지 비교하는 기준으로 쓴다.

## 1. 기준선 검증 상태 (Phase 0)

main 기준 명령 재실행 결과:

| 명령 | 결과 |
|---|---|
| `pnpm typecheck` | ✅ pass |
| `pnpm verify:frontend` (tsc + vite build) | ✅ pass |
| `pnpm verify:backend` (server lint + typecheck + build) | ✅ pass |
| `pnpm verify:all` | ✅ pass (exit 0) |

## 2. 현재 아키텍처 요약

```txt
Frontend (repo root): React 19 + Vite + React Router + Zustand + TanStack Query + Tiptap + Yjs/y-websocket
  - 인증: Supabase Auth (supabase-js), authStore가 Supabase Session/User + profile 보관
  - 데이터 읽기: supabase-js로 workspaces/channels/documents/messages/profiles 직접 조회 (RLS 권한)
  - 실시간 무효화: Supabase Realtime postgres_changes 구독 + 폴링 fallback
  - 협업: Yjs room chat:{ws}:{ch}, doc:{ws}:{doc} (y-websocket → 백엔드)
  - 일부 백엔드 HTTP 호출: backendClient (workspace create/join/delete, Bearer = Supabase token)

Backend (server/ workspace package): Node node:http + ws
  - http/app.ts: 수동 pathname 분기 (/health, /ready, /api/workspaces[/join], DELETE /api/workspaces/:id)
  - 실시간: setupYWebsocket → @y/websocket-server, room chat/doc
  - 채팅 영속화: Supabase messages 테이블 (service role)
  - 문서 영속화: 파일 시스템 .syncspace-data/ydocs/*.bin
  - 인증: WS_AUTH_MODE=off|supabase, supabase 모드는 token + workspace_members 검사

DB/Auth: Supabase Postgres + Auth + RLS (supabase/schema.sql, rls.sql, seed.sql)
  - profiles(→auth.users), workspaces, workspace_members, channels, documents, messages

Deploy: Frontend=Vercel, Backend=Railway, DB/Auth=Supabase
```

핵심 realtime room 구조는 유지: `chat:{workspaceId}:{channelId}`, `doc:{workspaceId}:{documentId}`.

## 3. 목표 구조 (이 브랜치)

```txt
Railway-only: web(Caddy+정적) / api(node:http + WS + REST + A2A) / agent-worker / postgres
DB: Railway PostgreSQL 단일 영속 저장소 (자체 소유 스키마, RLS 제거 → app-owned authorization)
인증: Supabase Auth 제거 → app_users + auth_sessions + 세션 쿠키
참여자: participants 추상화 (human/agent)
에이전트: agents/tasks/events/artifacts + A2A HTTP+JSON/REST/SSE/push 전체 구현
문서 snapshot: 파일 → PostgreSQL (yjs_document_snapshots), 파일 fallback env 유지
```

## 4. 로컬 검증 전략

프로덕션 인프라(Railway/Supabase/DNS) 자격증명이 없으므로, 코드/설정/런북으로 구현하고
**임베디드 Postgres**(`embedded-postgres`, 번들 PG 18 바이너리, Docker 불필요)로 마이그레이션과
통합 테스트를 실제 PG 시맨틱으로 검증한다.

```bash
pnpm db:migrate        # DATABASE_URL 대상 마이그레이션 적용
pnpm db:verify         # 적용 상태 + 데이터 정합성 검증
pnpm --filter server test   # 임베디드 PG로 부팅 → 마이그레이션 → 통합 테스트
```

인프라 의존 단계(Railway 프로비저닝, Supabase 덤프/복원, DNS 컷오버, 프로덕션 데이터 이전)는
실제 실행 대신 `docs/migration/*` 런북으로 문서화한다.

## 5. 롤백

- `main` 브랜치 유지, 본 브랜치 삭제 가능.
- 각 Phase는 feature flag / env 토글 / 파일 fallback으로 롤백 경로를 가진다.
