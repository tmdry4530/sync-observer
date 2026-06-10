# Env Inventory — Railway 마이그레이션

문서 버전: 2026-06-09
관련: `railway.api.toml`, `railway.worker.toml`, `railway.web.toml`, `Caddyfile`, `.env.example`

이 문서는 SyncSpace의 모든 환경변수를 서비스(web/api/worker/build)별로 정리한다.
신규 Railway 변수와, 컷오버 후 제거할 legacy Supabase/Vercel 변수를 함께 기록한다.

서비스 표기 / service column:
- **api** — Railway api 서비스 (REST + WebSocket + A2A)
- **worker** — Railway agent-worker 서비스 (백그라운드 잡, 포트 없음)
- **web** — Railway web 서비스 (Caddy 정적 + 프록시)
- **build** — 빌드 타임/프런트엔드 번들에 인라인되는 값 (`VITE_*`)

## 1. App-owned auth + Postgres (신규 / Railway)

| Name | Service | Purpose | Example / Placeholder | Secret? |
|---|---|---|---|---|
| `DATABASE_URL` | api, worker, build(db:migrate) | Postgres 단일 영속 저장소 연결 문자열 | `postgres://user:pass@host:5432/syncspace` | ✅ |
| `AUTH_SECRET` | api, worker | 세션/토큰 서명 비밀키 | `<long-random>` | ✅ |
| `SESSION_COOKIE_NAME` | api | 세션 쿠키 이름 | `syncspace_session` | ❌ |
| `SESSION_COOKIE_DOMAIN` | api | 세션 쿠키 도메인 | `.syncspace.app` | ❌ |
| `AGENT_TOKEN_PEPPER` | api, worker | 에이전트 토큰 해시 pepper | `<random>` | ✅ |
| `PUBLIC_APP_URL` | api, worker | 외부 노출 앱 기본 URL | `https://syncspace.app` | ❌ |
| `A2A_VERSION` | api, worker | A2A 프로토콜 버전 (고정) | `1.0` | ❌ |
| `A2A_INTERFACE_URL` | api, worker | A2A JSON-RPC interface URL | `https://syncspace.app/a2a` | ❌ |
| `A2A_AGENT_CARD_URL` | api | A2A agent card URL | `https://syncspace.app/.well-known/agent-card.json` | ❌ |
| `WS_AUTH_MODE` | api | 실시간 인증 모드 `off\|supabase\|session` | `session` | ❌ |
| `STRICT_READY_CHECKS` | api | `/ready`에서 DB 장애를 503으로 볼지 여부. Railway deploy healthcheck는 기본 `false` 권장 | `false` | ❌ |
| `SYNCSPACE_DOC_PERSISTENCE_MODE` | api | 문서 영속화 모드 `file\|postgres` | `postgres` | ❌ |
| `SYNCSPACE_DOC_PERSISTENCE_DIR` | api | `mode=file` 일 때 스냅샷 경로 | `.syncspace-data/ydocs` | ❌ |
| `ALLOWED_ORIGINS` | api | WS/CORS 허용 origin (쉼표 구분) | `https://syncspace.app` | ❌ |
| `LOG_LEVEL` | api, worker | 로그 레벨 `error\|warn\|info\|debug` | `info` | ❌ |
| `NODE_ENV` | api, worker | 런타임 환경 | `production` | ❌ |
| `HOST` | api | 바인드 호스트 | `0.0.0.0` | ❌ |
| `PORT` | api, web | listen 포트 (Railway 주입) | `8080` | ❌ |
| `AUTH_ALLOW_EXTERNAL_AGENT_REGISTRATION` | api | production에서 `/api/v1/agents/register*` public external-agent registration 활성화 | `true` | ❌ |

## 2. agent-worker 전용 (신규)

| Name | Service | Purpose | Example / Placeholder | Secret? |
|---|---|---|---|---|
| `WORKER_ID` | worker | 워커 인스턴스 식별자 | `worker-1` | ❌ |
| `AGENT_WORKER_ENABLED` | worker | 에이전트 task 처리 워커 on/off | `true` | ❌ |
| `PUSH_WORKER_ENABLED` | worker | push(웹훅) 전송 워커 on/off | `true` | ❌ |

## 3. web 서비스 (Caddy) 전용 (신규)

| Name | Service | Purpose | Example / Placeholder | Secret? |
|---|---|---|---|---|
| `PORT` | web | Caddy listen 포트 (Railway 주입) | `8080` | ❌ |
| `API_INTERNAL_URL` | web | api 서비스 private URL (reverse_proxy 대상) | `http://api.railway.internal:8080` | ❌ |

## 4. Frontend (build-time, VITE_*)

| Name | Service | Purpose | Example / Placeholder | Secret? |
|---|---|---|---|---|
| `VITE_API_URL` | build | API 베이스 경로 (기본 `/api`, Caddy 동일 오리진 프록시) | `/api` | ❌ |
| `VITE_WS_URL` | build | WebSocket 베이스 URL | `wss://syncspace.app` | ❌ |

## 5. Legacy (Supabase / Vercel — 컷오버 후 제거)

컷오버(Phase 19-20) 완료 + 안정화 후 `docs/migration/cleanup.md`에 따라 제거한다.

| Name | Service | Purpose | Example / Placeholder | Secret? | 상태 |
|---|---|---|---|---|---|
| `SUPABASE_URL` | api(legacy) | Supabase 프로젝트 URL | `https://xxx.supabase.co` | ❌ | remove after cutover |
| `SUPABASE_SERVICE_ROLE_KEY` | api(legacy) | Supabase service role 키 | `<service-role-key>` | ✅ | remove after cutover |
| `VITE_SUPABASE_URL` | build(legacy) | 프런트 Supabase URL | `https://xxx.supabase.co` | ❌ | remove after cutover |
| `VITE_SUPABASE_ANON_KEY` | build(legacy) | 프런트 Supabase anon 키 | `<anon-key>` | ❌(공개) | remove after cutover |
| `VITE_WS_AUTH_MODE` | build(legacy) | 프런트 WS 인증 힌트 | `supabase` | ❌ | remove after cutover |

## 6. 주의사항 / notes

- secret(✅) 값은 Railway 서비스 변수의 sealed/secret으로만 주입한다. lockfile/repo에 두지 않는다.
- `DATABASE_URL`은 api·worker·`pnpm db:migrate`(build/release 단계) 모두에서 동일 인스턴스를 가리켜야 한다.
- `API_INTERNAL_URL`의 포트는 api 서비스의 `PORT`와 일치해야 한다(Railway private network).
- `A2A_*` URL은 `PUBLIC_APP_URL`과 도메인이 일치해야 외부 에이전트가 카드/인터페이스를 찾는다.
