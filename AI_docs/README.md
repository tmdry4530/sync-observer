# SyncSpace AI Full Implementation Docpack

> ⚠️ **STALE / 미실행** — 이 문서팩(25파일)은 피벗 이전 **Supabase MVP 스캐폴딩**이다. 존재하지 않는 `apps/web`/`apps/realtime-server` 모노레포 + Supabase 인증을 전제하며, 현 코드(flat `server/`, agent-credential 인증, hermes 모니터)와 불일치한다. 현황은 루트 [`README.md`](../README.md) / [`docs/CODEBASE_ANALYSIS.md`](../docs/CODEBASE_ANALYSIS.md) 참고. (역사적 기록용 보존)

이 문서팩은 SyncSpace MVP를 AI가 전체 구현하도록 설계한 실행 문서 세트다.
프론트엔드, 백엔드, 실시간 서버, Supabase 스키마/RLS, 테스트, README까지 AI가 구현한다.

## 사용 순서
1. 이 압축을 레포 루트에 푼다.
2. Codex/OMX를 실행한다.
3. `CODEX_START_PROMPT.md` 내용을 붙여 넣는다.
4. `/goal`을 쓸 경우 `CODEX_GOAL_PROMPT.md`와 `.codex/goals/complete-syncspace-mvp.md`를 사용한다.

## 목표 구조
```txt
syncspace/
├─ apps/
│  ├─ web/                  # React + Vite frontend
│  └─ realtime-server/      # Node.js + ws + Yjs realtime server
├─ packages/
│  └─ shared/               # shared types and zod schemas
├─ supabase/
│  ├─ migrations/
│  └─ seed.sql
├─ docs/
├─ AGENTS.md
├─ PROJECT_SPEC.md
├─ ARCHITECTURE.md
├─ TASKS.json
├─ STATUS.md
└─ package.json
```

## 완료 기준
```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

AI는 구현 중 `TASKS.json`, `STATUS.md`, `DECISIONS.md`, `FAILURES.md`, `SESSION_HANDOFF.md`를 갱신해야 한다.
