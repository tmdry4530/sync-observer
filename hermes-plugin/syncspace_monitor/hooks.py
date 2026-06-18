"""hook 콜백 구현 — pre/post/subagent + pre-block 결정 (stdlib only).

계약 (HERMES_OPERATION ②④ 실측):
  - on_pre_tool_call: {"action":"block","message":...} 반환 시 hermes가 실행 전 차단.
    None/기타 반환은 관찰자로 무시.
  - on_post_tool_call / on_subagent_*: 반환값 무시(관찰 전용).
모든 콜백은 절대 예외를 밖으로 던지지 않는다(에이전트 루프 보호).

interrupt seam (M5 결선):
  플러그인은 hermes 에이전트 실행 스레드에서 IN-PROCESS로 돈다(hermes_cli/plugins.py
  invoke_hook → cb(**kwargs)). pre_tool_call hook은 실행 스레드에서 동기 디스패치되므로,
  여기서 tools.interrupt.set_interrupt(True)를 호출하면 *현재(실행) 스레드*가 interrupted
  set에 등록된다. 이후 같은 턴의 모든 툴이 is_interrupted()로 abort("[interrupted]").
  이것이 폼-무관(embedded/gateway/api-server/relay 모두 in-process) 동작이다.
  resolver는 테스트를 위해 Monitor.__init__(interrupt_resolver=...)로 교체 가능하다.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from . import events as _events
from .config import Config, load_config
from .emit import EventEmitter
from .rules import RuleStore, normalize_path

logger = logging.getLogger(__name__)


def _default_interrupt_resolver(**_kwargs: Any) -> None:
    """기본 interrupt resolver — 현재(실행) 스레드를 in-process로 interrupt한다.

    hermes의 tools.interrupt.set_interrupt(True)는 thread_id=None일 때 *현재 스레드*를
    interrupted set에 추가한다. pre_tool_call hook은 에이전트 실행 스레드에서 동기
    디스패치되므로, 이 호출은 같은 턴의 후속 툴을 전부 abort 시킨다(agent.interrupt()의
    툴-abort 절반을 모듈 함수로 복제).

    hermes 밖(테스트/독립 실행)에서는 tools.interrupt가 없으므로 ImportError를 흡수하고
    조용히 반환한다 — 절대 예외를 밖으로 던지지 않는다(에이전트 루프 보호).
    """
    try:
        from tools.interrupt import set_interrupt  # type: ignore[import-not-found]
    except Exception:
        logger.debug(
            "syncspace: tools.interrupt unavailable (not inside hermes); "
            "skipping in-process interrupt"
        )
        return None
    try:
        set_interrupt(True)
    except Exception:
        logger.exception("syncspace: set_interrupt(True) failed (fail-open)")
    return None


# post_tool_call 상태 매핑 (명시 분기 + rawStatus 보존).
_POST_STATUS_MAP: dict[str, str] = {
    "ok": "success",
    "success": "success",
    "error": "error",
    "failed": "error",
    "failure": "error",
    "blocked": "blocked",
    "cancelled": "cancelled",
    "canceled": "cancelled",
}


class Monitor:
    """플러그인 런타임 상태 보유자 (RuleStore + EventEmitter + seam).

    register()가 단일 인스턴스를 만들어 hook 콜백을 메서드 바인딩으로 등록한다.
    """

    def __init__(
        self,
        config: Optional[Config] = None,
        rule_store: Optional[RuleStore] = None,
        emitter: Optional[EventEmitter] = None,
        interrupt_resolver: Optional[Callable[..., None]] = None,
        poll_fn: Optional[Callable[..., Optional[dict]]] = None,
    ) -> None:
        self.config = config or load_config()
        self.rules = rule_store or RuleStore(self.config.rules_file)
        self.emitter = emitter or EventEmitter(
            ingest_url=self.config.ingest_url,
            timeout_s=self.config.emit_timeout_s,
            queue_maxsize=self.config.queue_maxsize,
        )
        # interrupt resolver: 기본은 in-process set_interrupt. 테스트는 fake 주입.
        self.interrupt_resolver: Callable[..., None] = (
            interrupt_resolver or _default_interrupt_resolver
        )
        # pending 폴 함수: 기본은 urllib GET. 테스트는 fake 주입(네트워크 없음).
        self._poll_fn: Callable[..., Optional[dict]] = poll_fn or self._http_poll_pending
        # M5 수동중지 폴 스로틀(monotonic). -inf = 아직 폴 안 함(첫 호출 즉시 허용).
        self._last_interrupt_poll: float = float("-inf")

    # -- emit 헬퍼 -------------------------------------------------------

    def _safe_emit(self, event: dict) -> None:
        """emit는 절대 hook을 블록하지 않는다(예외 무시)."""
        try:
            self.emitter.emit(event)
        except Exception:
            # 관찰 실패 = 조용히 스킵.
            pass

    def _build(self, *, tool_name, args, status, kwargs, detail_extra=None) -> dict:
        """공통 이벤트 빌더(정규화 콜백 주입)."""
        return _events.build_event(
            tool_name=tool_name,
            args=args,
            status=status,
            session_id=kwargs.get("session_id"),
            task_id=kwargs.get("task_id"),
            turn_id=kwargs.get("turn_id"),
            tool_call_id=kwargs.get("tool_call_id"),
            disambiguator=self.config.agent_disambiguator,
            cwd=kwargs.get("cwd"),
            git_branch=kwargs.get("git_branch"),
            normalize_fn=normalize_path,
            detail_extra=detail_extra,
        )

    # -- 수동중지 폴 (M5) ------------------------------------------------

    def _http_poll_pending(
        self, agent_id: str, session_id: Optional[str]
    ) -> Optional[dict]:
        """컬렉터 /control/pending GET (urllib, 타이트 타임아웃, fail-open).

        계약: GET {pending_url}?agentId=<id>&sessionId=<id>
              헤더 X-SyncSpace-Local: 1
              응답 JSON {"interrupts":[{"id":n,"reason":str|null,"createdAt":iso}]}
        컬렉터가 읽을 때 소비(각 pending interrupt 1회 반환).

        반환: 파싱된 JSON dict, 또는 실패 시 None(예외 절대 전파 금지).
        """
        try:
            from urllib.parse import urlencode

            params = {"agentId": agent_id}
            if session_id:
                params["sessionId"] = session_id
            url = self.config.pending_url + "?" + urlencode(params)
            req = urllib.request.Request(
                url,
                method="GET",
                headers={"X-SyncSpace-Local": "1"},
            )
            with urllib.request.urlopen(req, timeout=self.config.emit_timeout_s) as resp:
                raw = resp.read()
            return json.loads(raw.decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError, TypeError):
            # 네트워크/타임아웃/JSON 파싱 실패 → 조용히 스킵.
            logger.debug("syncspace: pending poll failed (skip)", exc_info=True)
            return None
        except Exception:
            # 그 외 어떤 예외도 hook으로 새어나가지 않는다.
            logger.debug("syncspace: pending poll unexpected error (skip)", exc_info=True)
            return None

    def _poll_for_interrupt(
        self,
        agent_id: str,
        session_id: Optional[str],
        tool_name: str,
        args: Any,
        kwargs: dict,
    ) -> Optional[dict]:
        """스로틀된 pending 폴 → interrupt 발견 시 resolver 호출 + block 반환.

        완전 fail-open: 어떤 예외도 삼키고 None(=차단 안 함) 반환.
        반환: interrupt 있으면 {"action":"block","message":...}, 아니면 None.
        """
        try:
            if not self.config.interrupt_poll_enabled:
                return None
            now = time.monotonic()
            if (now - self._last_interrupt_poll) < self.config.interrupt_poll_min_interval_s:
                return None
            # 폴 시각 갱신(실패해도 갱신 — 폭주 방지).
            self._last_interrupt_poll = now

            data = self._poll_fn(agent_id, session_id)
            if not isinstance(data, dict):
                return None
            interrupts = data.get("interrupts")
            if not isinstance(interrupts, list) or not interrupts:
                return None

            first = interrupts[0] if isinstance(interrupts[0], dict) else {}
            reason = first.get("reason") if isinstance(first, dict) else None
            reason = reason if isinstance(reason, str) and reason else None

            # in-process interrupt 트리거(실행 스레드 마킹). 예외 흡수.
            try:
                self.interrupt_resolver(
                    reason=reason, agent_id=agent_id, session_id=session_id
                )
            except Exception:
                logger.exception("syncspace: interrupt_resolver raised (fail-open)")

            # 컬렉터가 이미 cancelled 이벤트를 기록/브로드캐스트했으므로
            # detail.intervention 없이 status='blocked' 캡처만(중복 감사 방지).
            self._safe_emit(
                self._build(
                    tool_name=tool_name,
                    args=args,
                    status="blocked",
                    kwargs=kwargs,
                    detail_extra=None,
                )
            )

            message = "SyncSpace manual interrupt" + (
                ": " + reason if reason else ""
            )
            return {"action": "block", "message": message}
        except Exception:
            logger.exception("syncspace: _poll_for_interrupt failed (fail-open)")
            return None

    # -- pre_tool_call ---------------------------------------------------

    def on_pre_tool_call(
        self,
        tool_name: str = "",
        args: Any = None,
        **kwargs: Any,
    ) -> Optional[dict]:
        """실행 전 게이트: 캡처 emit(started) + 규칙 평가 → block 결정.

        반환: deny 매치 시 {"action":"block","message":...}, 아니면 None.
        예외는 전부 흡수(fail-open: 차단 판단 실패 시 block 안 함, 로깅).
        """
        try:
            session_id = kwargs.get("session_id")
            cwd = kwargs.get("cwd")
            agent_id = _events.derive_agent_id(
                session_id, self.config.agent_disambiguator
            )

            # 1. 후보 경로 추출 (tuple 언패킹).
            raw_paths, path_parse_miss = _events.extract_raw_paths(tool_name, args)

            block_decision = None
            blocked_path = None
            normalize_failed_any = False

            for raw in raw_paths:
                norm = normalize_path(raw, cwd)
                if norm is None:
                    # 정규화 실패 → raw 폴백 + 플래그 (fail-open: 블록 안 함).
                    normalize_failed_any = True
                    logger.debug(
                        "syncspace: normalize_path failed for %r (raw fallback)", raw
                    )
                    target = raw
                else:
                    target = norm
                try:
                    decision = self.rules.evaluate(target, session_id, agent_id)
                except Exception:
                    # 규칙 평가 실패 = fail-open(차단 안 함) + 로깅.
                    logger.warning("syncspace: rule eval failed for %r", target)
                    continue
                if not decision.allowed:
                    block_decision = decision
                    blocked_path = target
                    break

            # 2. block 대상 판정: 1급 파일 툴 또는 terminal(경로 파싱 성공).
            can_block = tool_name in _events.FIRST_CLASS_FILE_TOOLS or (
                tool_name == "terminal" and bool(raw_paths)
            )

            # 가시화 플래그 detail_extra 조합.
            visibility_extra: dict = {}
            if path_parse_miss:
                visibility_extra["pathParseMiss"] = True
            if normalize_failed_any:
                visibility_extra["normalizeFailed"] = True

            if block_decision is not None and can_block:
                rule_id = block_decision.rule_id or "?"
                message = (
                    f"SyncSpace blocked {tool_name} on {blocked_path} "
                    f"(rule: {rule_id})"
                )
                intervention = {
                    "intervention": {
                        "ruleId": rule_id,
                        "mode": "block",
                        "trigger": "auto",
                        "message": message,
                    }
                }
                intervention.update(visibility_extra)
                # 개입 이벤트 emit (status=blocked, trigger=auto).
                self._safe_emit(
                    self._build(
                        tool_name=tool_name,
                        args=args,
                        status="blocked",
                        kwargs=kwargs,
                        detail_extra=intervention,
                    )
                )
                return {"action": "block", "message": message}

            # 2.5 규칙 블록이 아니면 수동중지(M5) 스로틀 폴.
            #     interrupt 발견 시 in-process로 실행 스레드를 interrupt하고 block 반환.
            #     완전 fail-open(폴 실패는 절대 차단/예외로 이어지지 않음).
            poll_block = self._poll_for_interrupt(
                agent_id, session_id, tool_name, args, kwargs
            )
            if poll_block is not None:
                return poll_block

            # 3. 차단 없음: 캡처 이벤트 emit (status=started).
            self._safe_emit(
                self._build(
                    tool_name=tool_name,
                    args=args,
                    status="started",
                    kwargs=kwargs,
                    detail_extra=visibility_extra or None,
                )
            )
            return None
        except Exception:
            # 어떤 예외도 에이전트 루프로 새어나가지 않도록 fail-open.
            logger.exception("syncspace: on_pre_tool_call failed (fail-open)")
            return None

    # -- post_tool_call --------------------------------------------------

    def on_post_tool_call(
        self,
        tool_name: str = "",
        args: Any = None,
        result: Any = None,
        **kwargs: Any,
    ) -> None:
        """실행 직후 관찰 emit (success|error|blocked|cancelled). 반환값 무시.

        ok → success 명시 분기. 매핑 안 되는 미지값은 success로 흡수하되
        detail.rawStatus 에 원본값 보존.
        """
        try:
            raw_status = kwargs.get("status")
            raw_str = raw_status.lower() if isinstance(raw_status, str) else None
            mapped = _POST_STATUS_MAP.get(raw_str, None) if raw_str else None

            if mapped is not None:
                status = mapped
                raw_status_preserved = None  # 매핑 성공 → rawStatus 불필요.
            else:
                # 미지 상태값: success로 흡수 + rawStatus 보존.
                status = "success"
                raw_status_preserved = raw_status

            detail_extra: dict = {}
            if kwargs.get("duration_ms") is not None:
                detail_extra["durationMs"] = kwargs.get("duration_ms")
            if raw_status_preserved is not None:
                detail_extra["rawStatus"] = str(raw_status_preserved)

            self._safe_emit(
                self._build(
                    tool_name=tool_name,
                    args=args,
                    status=status,
                    kwargs=kwargs,
                    detail_extra=detail_extra or None,
                )
            )
        except Exception:
            logger.exception("syncspace: on_post_tool_call failed")

    # -- subagent lifecycle (관찰 전용, 빠르게) --------------------------

    def on_subagent_start(self, **kwargs: Any) -> None:
        """서브에이전트 시작 관찰 emit (빠르게 반환)."""
        try:
            event = _events.build_event(
                tool_name="delegate_task",
                args={},
                status="started",
                session_id=kwargs.get("session_id") or kwargs.get("parent_session_id"),
                task_id=kwargs.get("task_id"),
                turn_id=kwargs.get("turn_id") or kwargs.get("parent_turn_id"),
                tool_call_id=kwargs.get("tool_call_id"),
                disambiguator=self.config.agent_disambiguator,
                detail_extra={"subagent": "start"},
            )
            self._safe_emit(event)
        except Exception:
            logger.exception("syncspace: on_subagent_start failed")

    def on_subagent_stop(self, **kwargs: Any) -> None:
        """서브에이전트 종료 관찰 emit. turn당 다수 발화 가능 → 가볍게."""
        try:
            child_status = kwargs.get("child_status")
            raw_str = child_status.lower() if isinstance(child_status, str) else None
            mapped = _POST_STATUS_MAP.get(raw_str, None) if raw_str else None
            status = mapped if mapped else "success"
            event = _events.build_event(
                tool_name="delegate_task",
                args={},
                status=status,
                session_id=kwargs.get("session_id") or kwargs.get("parent_session_id"),
                task_id=kwargs.get("task_id"),
                turn_id=kwargs.get("turn_id") or kwargs.get("parent_turn_id"),
                disambiguator=self.config.agent_disambiguator,
                detail_extra={
                    "subagent": "stop",
                    "childRole": kwargs.get("child_role"),
                    "childStatus": child_status,
                    "childSummary": kwargs.get("child_summary"),
                    "durationMs": kwargs.get("duration_ms"),
                },
            )
            self._safe_emit(event)
        except Exception:
            logger.exception("syncspace: on_subagent_stop failed")
