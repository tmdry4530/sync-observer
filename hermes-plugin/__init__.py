"""syncspace-monitor hermes 플러그인 진입점.

hermes 플러그인 규약(HERMES_OPERATION ⑦):
  디렉터리 = plugin.yaml manifest + __init__.py 의 register(ctx) 함수.
  로드 시 hermes가 register(ctx)를 호출하고, 그 안에서
  ctx.register_hook(hook_name, callback) 로 콜백을 등록한다.

security-guidance 플러그인 패턴을 그대로 따른다 — register()에서
pre_tool_call(개입/규칙) + post_tool_call(관찰) + subagent_* 를 등록.

⚠️ always-on: security-guidance와 달리 env 게이트 없이 항상 활성화.
   (단 규칙 파일이 비어 있으면 기본정책 allow라 차단은 일어나지 않는다.)
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# 단일 Monitor 인스턴스(프로세스 1개). register 시 지연 생성.
_monitor = None


def _get_monitor():
    """Monitor 싱글톤을 지연 생성한다.

    플러그인 디렉터리 로드 시 패키지명이 환경마다 달라질 수 있어,
    절대/상대 import 양쪽을 시도한다(stdlib only).
    """
    global _monitor
    if _monitor is not None:
        return _monitor
    Monitor = None
    try:
        # 패키지로 로드된 경우(권장: __init__.py 가 패키지의 일부).
        from .syncspace_monitor import Monitor  # type: ignore
    except Exception:
        try:
            # 플러그인 디렉터리가 sys.path에 있는 경우의 폴백.
            from syncspace_monitor import Monitor  # type: ignore
        except Exception:
            logger.exception("syncspace-monitor: failed to import core")
            return None
    _monitor = Monitor()
    return _monitor


def register(ctx) -> None:
    """hermes 플러그인 등록 진입점.

    pre_tool_call  -> 규칙 평가 + pre-block + 캡처 emit
    post_tool_call -> 관찰 emit
    subagent_start / subagent_stop -> 관찰 emit
    """
    monitor = _get_monitor()
    if monitor is None:
        logger.error("syncspace-monitor: register skipped (core unavailable)")
        return
    ctx.register_hook("pre_tool_call", monitor.on_pre_tool_call)
    ctx.register_hook("post_tool_call", monitor.on_post_tool_call)
    ctx.register_hook("subagent_start", monitor.on_subagent_start)
    ctx.register_hook("subagent_stop", monitor.on_subagent_stop)
