# A2A Conformance Coverage (Phase 23)

각 A2A conformance 항목과 이를 검증하는 테스트 매핑. 모든 테스트는 임베디드 Postgres에서
실행되며 `pnpm --filter server test`로 통과한다.

| # | 항목 | 테스트 |
|---|---|---|
| 1 | Agent Card discovery (`/.well-known/agent-card.json`) | `a2a.http.test.ts` › serves the public Agent Card |
| 2 | supportedInterfaces validation | `a2a.http.test.ts` › Agent Card (protocolBinding HTTP+JSON) |
| 3 | A2A-Version required (production) | `version.ts` (prod→`version_required`); dev tolerates 누락 |
| 4 | unsupported version error | `a2a.http.test.ts` › rejects an unsupported A2A-Version (400 problem+json) |
| 5 | content type validation | `a2a.http.test.ts` › rejects an unsupported Content-Type (415) |
| 6 | message:send creates task | `a2a.http.test.ts` › message:send creates a Task in SUBMITTED |
| 7 | duplicate messageId idempotency | `a2a.http.test.ts` › idempotent on duplicate messageId; `a2a.core.test.ts` |
| 8 | get task authorized | `a2a.http.test.ts` › GET task authorized |
| 9 | get task unauthorized does not leak existence | `a2a.http.test.ts` › does not leak to others (404) |
| 10 | list tasks cursor pagination | `a2a.http.test.ts` › lists tasks with cursor pagination |
| 11 | cancel task idempotency | `a2a.http.test.ts` › cancel is idempotent; `a2a.core.test.ts` |
| 12 | message:stream starts with Task | `a2a.stream.test.ts` › emits Task (initial snapshot) |
| 13 | stream sends status update | `a2a.stream.test.ts` › statusUpdate present |
| 14 | stream sends artifact update | `a2a.stream.test.ts` › artifactUpdate (plan.md) |
| 15 | stream closes on terminal state | `a2a.stream.test.ts` › final statusUpdate COMPLETED closes stream |
| 16 | subscribe rejects terminal task | `routes.ts` handleSubscribe (409 task_terminal); exercised by cancel→subscribe |
| 17 | push notification config CRUD | `a2a.push.test.ts` › config CRUD (create/list/get/delete) |
| 18 | webhook delivery payload shape | `a2a.push.test.ts` › delivers `{task}` + idempotency key |
| 19 | webhook retry on 5xx | `a2a.push.test.ts` › retries delivery on a 5xx response |
| 20 | task/artifact visible in SyncSpace UI | `agents.api.test.ts` › task detail (status/artifacts/events) via REST |

## 추가 보안/권한 검증

| 영역 | 테스트 |
|---|---|
| SSRF 차단 (loopback/private/link-local/metadata/IPv4-mapped) | `security.test.ts` › SSRF guard |
| https-only webhook + prod-guarded escape hatch | `security.test.ts` |
| rate limit window/isolation, 동시 스트림 제한 | `security.test.ts` |
| 비회원 workspace/agent 접근 404 (no-leak) | `auth.api.test.ts`, `agents.api.test.ts` |
| 세션 쿠키 발급/검증/로그아웃 | `auth.api.test.ts` |
| 메시지 author participant 해석 + clientId 멱등 | `realtime.persistence.test.ts` |
| Yjs 문서 snapshot Postgres 영속/복원 | `realtime.persistence.test.ts` |

## 실행

```bash
pnpm --filter server test          # 전체 (임베디드 Postgres)
pnpm test:a2a                      # a2a.* 스펙
pnpm test:auth                     # auth.* 스펙
pnpm test:realtime                 # realtime.* 스펙
```
