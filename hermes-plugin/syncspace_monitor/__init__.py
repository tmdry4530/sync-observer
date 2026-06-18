"""syncspace_monitor — hermes 에이전트 활동 모니터링 + 개입 코어.

모듈 구성:
  config  : env 기반 설정.
  rules   : 경로 allow/deny 규칙엔진 (deny-overrides, realpath, stdlib glob).
  events  : hook kwargs -> PIVOT §3 정규화 이벤트.
  emit    : 백그라운드 큐 + urllib POST (fire-and-forget).
  hooks   : pre/post/subagent 콜백 + pre-block 결정 + interrupt seam.

순수 stdlib. 외부 pip 의존 0. Python 3.10+.
"""

from __future__ import annotations

from .hooks import Monitor

__all__ = ["Monitor"]
__version__ = "0.1.0"
