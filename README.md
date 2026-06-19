# sync-observer

> **로컬 hermes 에이전트 활동 모니터링 + 개입 도구.**
> 로컬에서 동작하는 NousResearch [hermes-agent](https://hermes-agent.nousresearch.com)의 모든 툴 호출(파일 읽기/쓰기/검색/터미널)을 실시간으로 **관찰**하고, 경로 규칙으로 **사전 차단**하거나 진행 중인 턴을 **수동 중지**한다. 단일 사용자용 localhost 도구(인증 없음, `127.0.0.1` 바인딩).

이 레포는 원래 SyncSpace 협업 앱이었다가 이 모니터로 피벗했고, 레거시 협업 앱/백엔드는 모두 제거되어 현재는 모니터 코드만 남아 있다.

---

## 빠른 시작 (한 줄 설치)

```bash
curl -fsSL https://raw.githubusercontent.com/tmdry4530/sync-observer/main/install.sh | bash
```

설치기가 레포 클론 → 의존성 설치 → **hermes 플러그인 자동 심링크+enable** → `observer` 런처를 `~/.local/bin`에 설치한다. (플러그인 연결을 자동화하므로 사용자가 플러그인을 직접 만질 필요가 없다.)

그다음 **한 단어로 전체 시스템 실행**:

```bash
observer            # 컬렉터(:8787) + 모니터 UI(:5173) 기동 → 브라우저 자동 열림
observer stop       # 모두 중지
observer status     # 상태/포트 확인
observer logs       # 로그 tail
observer restart    # 재시작
```

> 사전 요구: `node 22`, `pnpm`, `python3`, `git`, 그리고 hermes(플러그인 연결용). hermes 세션은 플러그인 enable 후 한 번 재시작한다.

---

## 아키텍처 — 3계층 파이프라인

```txt
[hermes 에이전트 프로세스]
        │ 플러그인 in-process 훅 (pre_tool_call / post_tool_call / subagent_*)
        ▼
① hermes-plugin/                 Python 플러그인 (순수 stdlib)
        │  POST /ingest/events     정규화 이벤트 fire-and-forget emit
        │  GET  /control/pending   수동 인터럽트 폴링
        ▼
② server/src/collector/          로컬 컬렉터 (node:sqlite, 127.0.0.1:8787)
        │  GET  /api/stream(SSE) · /api/events · /api/sessions · /api/tree · /api/interventions
        │  POST /control/rules · /control/interrupt
        ▼
③ src/features/monitor/ + /monitor   React SPA (IdeShell + 6탭)
```

| 계층 | 위치 | 역할 |
| --- | --- | --- |
| ① 플러그인 | `hermes-plugin/` | 훅에서 이벤트 정규화·emit, 경로 allow/deny 사전 차단, 수동 인터럽트 |
| ② 컬렉터 | `server/src/collector/` | 이벤트 수집(sqlite) + SSE 팬아웃 + 규칙/인터럽트 control plane |
| ③ 모니터 UI | `src/features/monitor/`, `/monitor` | 파일트리 활동 오버레이 + 대시보드/활동/타임라인/개입/규칙/중지 6탭 |

> **이벤트 계약**은 세 곳이 하나로 묶여 있다: 플러그인 `syncspace_monitor/events.py` ↔ 컬렉터 `collector/activityEvent.ts`(zod, 권위) ↔ 프론트 `src/shared/types/activityEvent.ts`(미러). 하나를 바꾸면 셋을 함께 바꾼다.

---

## 수동 실행 (대안)

`observer` 없이 직접 띄우려면:

```bash
pnpm install
pnpm --filter server dev:collector   # 터미널 A — 컬렉터 (127.0.0.1:8787, DATABASE_URL 불필요)
pnpm dev:frontend                    # 터미널 B — 모니터 UI → http://127.0.0.1:5173/monitor
```

(`pnpm dev` 하나로 둘 다 띄울 수도 있다 — `scripts/dev-all.sh`.) hermes 에이전트에 플러그인을 연결하고 파일 도구를 쓰면 `/monitor`에 실시간 표시된다.

### 플러그인 수동 설치 (hermes)

`install.sh`가 자동으로 처리하지만, 직접 하려면:

hermes는 `~/.hermes/plugins/<name>/`의 `plugin.yaml` + `register(ctx)` 있는 `__init__.py`를 자동 발견한다(opt-in이라 enable 필요).

```bash
# A) 로컬 개발 — 심링크 (레포 수정 즉시 반영)
ln -s "$(pwd)/hermes-plugin" ~/.hermes/plugins/syncspace-monitor
hermes plugins enable syncspace-monitor

# B) 배포 레포에서 설치 (다른 머신)
hermes plugins install tmdry4530/hermes-plugin-syncspace-monitor --enable
```

enable 후 **다음 hermes 세션부터** 로드된다. 자세한 내용은 [`hermes-plugin/README.md`](hermes-plugin/README.md), 계약 봉인은 [`hermes-plugin/scripts/G0.md`](hermes-plugin/scripts/G0.md).

### 환경변수 (모두 선택)

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `SYNCSPACE_COLLECTOR_URL` | `http://127.0.0.1:8787` | 플러그인 emit 대상 |
| `SYNCSPACE_RULES_FILE` | `""` (규칙 없음=관찰만) | allow/deny 경로 규칙 JSON |
| `SYNCSPACE_COLLECTOR_PORT` | `8787` | 컬렉터 포트 |
| `SYNCSPACE_DB_PATH` | `./.syncspace/collector.db` | sqlite 경로 |

---

## 보안 모델

- 컬렉터는 **항상 `127.0.0.1`만 바인딩**(override 불가) — off-host 도달 불가.
- 상태 변경 라우트는 loopback + Origin allow-list, `/control/*`는 추가로 커스텀 `X-SyncSpace-Local: 1` 헤더(크로스사이트 폼이 설정 불가 → CSRF 방어)를 요구.
- 규칙 파일이 비면 기본정책 allow → **차단 없이 관찰만** 한다.

## 기술 스택 (모니터)

| 구분 | 기술 |
| --- | --- |
| 플러그인 | Python 3 (순수 stdlib, 외부 의존 0) |
| 컬렉터 | Node 22, `node:sqlite`, `node:http` (pg/Yjs 없음) |
| UI | React 19, TypeScript, Vite 8, React Router 7 |
| 스트림 | SSE (+ 폴링 폴백) |

## 검증

```bash
pnpm verify:frontend                 # tsc + vite build (모니터 UI 포함)
pnpm --filter server build           # 컬렉터/서버 src 빌드
python3 -m unittest discover -s hermes-plugin/tests   # 플러그인 단위 테스트
```