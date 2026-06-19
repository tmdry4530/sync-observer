# syncspace-monitor

> NousResearch **hermes-agent** 전용 로컬 활동 모니터링 + 개입 플러그인.

hermes 에이전트의 모든 도구 호출(`read_file`/`write_file`/`patch`/`search_files`/terminal)을
실행 전후로 가로채, 경로 규칙(allow/deny·deny-overrides·realpath)을 평가하고
모든 호출을 정규화 이벤트로 로컬 컬렉터에 fire-and-forget emit 한다.
순수 stdlib, 외부 의존 0. 규칙 파일이 비어 있으면 기본정책 allow → **차단 없이 관찰만** 한다.

이 디렉터리는 hermes 플러그인 규약을 따른다: 루트에 `plugin.yaml`(manifest) + `register(ctx)`를
가진 `__init__.py`. hermes는 로드 시 `register(ctx)`를 호출하고, 그 안에서
`pre_tool_call` / `post_tool_call` / `subagent_start` / `subagent_stop` 훅을 등록한다.

## 설치

플러그인 연결은 **sync-observer 설치기(curl 한 줄)가 자동 처리**한다 — 따로 설치할 필요 없다:

```bash
curl -fsSL https://raw.githubusercontent.com/tmdry4530/sync-observer/main/install.sh | bash
```

설치기가 이 디렉터리를 `~/.hermes/plugins/syncspace-monitor`로 심링크하고 `hermes plugins enable` 한다.

수동으로 연결하려면(개발 중 등):

```bash
ln -s "$(pwd)" ~/.hermes/plugins/syncspace-monitor
hermes plugins enable syncspace-monitor
```

hermes는 opt-in이라 `enable` 후 **다음 세션부터** 로드된다.
확인: `hermes plugins list` → `syncspace-monitor … enabled`.

## 컬렉터 연결

플러그인은 기본적으로 `http://127.0.0.1:8787`(SyncSpace 로컬 컬렉터)로 emit 한다.
컬렉터를 먼저 띄워야 이벤트가 쌓인다:

```bash
# sync-observer 레포에서
pnpm --filter server dev:collector      # 127.0.0.1:8787  /ingest/events
pnpm dev:frontend                       # http://127.0.0.1:5173/monitor (실시간 뷰)
```

## 환경변수 (모두 선택)

| 변수 | 기본값 | 용도 |
|---|---|---|
| `SYNCSPACE_COLLECTOR_URL` | `http://127.0.0.1:8787` | emit 대상 컬렉터 |
| `SYNCSPACE_RULES_FILE` | `""` (규칙 없음) | allow/deny 경로 규칙 JSON (컬렉터와 동일 경로 권장) |
| `SYNCSPACE_AGENT_DISAMBIGUATOR` | session_id 도출 | `agentId` 안정 접미사 고정 |
| `SYNCSPACE_EMIT_TIMEOUT_S` | `0.2` | emit POST 소켓 타임아웃 |
| `SYNCSPACE_INTERRUPT_POLL` | `true` | M5 수동중지 폴 활성화 |

env는 **hermes를 실행하는 셸**에 설정해야 플러그인이 읽는다.

## 검증 / 디버깅

```bash
python3 -m unittest discover -s tests -v      # 단위 테스트
python3 scripts/g0_validate.py scripts/g0_captured_payload.json   # G0 계약 검증
HERMES_PLUGINS_DEBUG=1 hermes ...             # 플러그인 발견/등록 로그를 stderr로
```

G0 봉인(실물 hermes payload ↔ 플러그인 계약 일치) 상세는 [`scripts/G0.md`](scripts/G0.md) 참고.

## 제거

```bash
hermes plugins disable syncspace-monitor   # 끄기
hermes plugins remove syncspace-monitor    # 삭제
# 로컬 심링크였다면: rm ~/.hermes/plugins/syncspace-monitor
```
