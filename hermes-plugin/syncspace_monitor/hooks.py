"""hook 콜백 구현 — pre/post/subagent + pre-block 결정 (stdlib only).

계약 (HERMES_OPERATION ②④ 실측):
  - on_pre_tool_call: {"action":"block","message":...} 반환 시 hermes가 실행 전 차단.
    None/기타 반환은 관찰자로 무시.
  - on_post_tool_call / on_subagent_*: 반환값 무시(관찰 전용).
모든 콜백은 절대 예외를 밖으로 던지지 않는다(에이전트 루프 보호).

interrupt seam (M5 예약):
  terminal/code에 대해 pre-block으로 못 막은 위반은 interrupt가 필요하나
  M1에서는 구현하지 않는다. interrupt_resolver 콜러블(기본 no-op)만 주입 가능한
  깨끗한 seam으로 남긴다. agent 참조가 필요하므로 폼별 바인딩은 M5.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Optional

from . import events as _events
from .config import Config, load_config
from .emit import EventEmitter
from .rules import RuleStore, normalize_path

logger = logging.getLogger(__name__)


def _noop_interrupt_resolver(**_kwargs: Any) -> None:
    """기본 interrupt seam — M1에서는 아무것도 하지 않는다(no-op).

    M5에서 배포 폼별로 agent.interrupt() 등을 바인딩해 주입한다.
    """
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
    ) -> None:
        self.config = config or load_config()
        self.rules = rule_store or RuleStore(self.config.rules_file)
        self.emitter = emitter or EventEmitter(
            ingest_url=self.config.ingest_url,
            timeout_s=self.config.emit_timeout_s,
            queue_maxsize=self.config.queue_maxsize,
        )
        # interrupt seam: 기본 no-op. M5에서 교체.
        self.interrupt_resolver: Callable[..., None] = (
            interrupt_resolver or _noop_interrupt_resolver
        )

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
