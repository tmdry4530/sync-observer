"""SyncSpace monitor 설정 — 환경변수 읽기 전담 (stdlib only).

모든 설정은 환경변수에서 읽고, 미지정 시 안전한 기본값으로 폴백한다.
이 모듈은 부수효과가 없어야 한다(읽기 전용 — 스레드/소켓 생성 금지).
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# 기본값 상수
DEFAULT_COLLECTOR_URL = "http://127.0.0.1:8787"
DEFAULT_EMIT_TIMEOUT_S = 0.2
DEFAULT_QUEUE_MAXSIZE = 1000
# /ingest/events 엔드포인트는 PIVOT §emit 전송 규약에 고정.
INGEST_PATH = "/ingest/events"


def _env_str(name: str, default: str) -> str:
    """환경변수를 문자열로 읽고, 비어 있으면 기본값 반환."""
    val = os.environ.get(name)
    if val is None:
        return default
    val = val.strip()
    return val or default


def _env_float(name: str, default: float) -> float:
    """환경변수를 float로 읽되, 파싱 실패 시 기본값 폴백."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        parsed = float(raw.strip())
    except (ValueError, AttributeError):
        return default
    # 음수/0 타임아웃은 의미가 없으므로 기본값으로 강등.
    return parsed if parsed > 0 else default


def _env_int(name: str, default: int) -> int:
    """환경변수를 int로 읽되, 파싱 실패 시 기본값 폴백."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        parsed = int(raw.strip())
    except (ValueError, AttributeError):
        return default
    return parsed if parsed > 0 else default


@dataclass(frozen=True)
class Config:
    """플러그인 런타임 설정 스냅샷.

    Attributes:
        collector_url: 컬렉터 베이스 URL (no trailing path). emit POST 대상.
        rules_file: 규칙 JSON 파일 절대경로 (없으면 빈 문자열 = 규칙 없음).
        agent_disambiguator: agentId(`hermes:<disambiguator>`) 안정 접미사 강제 지정값.
            빈 문자열이면 events 모듈이 session_id 프리픽스로 도출.
        emit_timeout_s: urllib POST 소켓 타임아웃(초).
        queue_maxsize: emit 백그라운드 큐 최대 크기 (초과 시 드롭).
        mask_home: UI/로그용 홈 경로 마스킹은 컬렉터/프론트 책임 — 여기선 미사용 플래그(예약).
    """

    collector_url: str
    rules_file: str
    agent_disambiguator: str
    emit_timeout_s: float
    queue_maxsize: int

    @property
    def ingest_url(self) -> str:
        """이벤트 ingest 전체 URL (collector_url + /ingest/events)."""
        base = self.collector_url.rstrip("/")
        return base + INGEST_PATH


def load_config() -> Config:
    """현재 환경변수에서 Config를 구성해 반환한다.

    읽는 env:
        SYNCSPACE_COLLECTOR_URL, SYNCSPACE_RULES_FILE,
        SYNCSPACE_AGENT_DISAMBIGUATOR, SYNCSPACE_EMIT_TIMEOUT_S,
        SYNCSPACE_QUEUE_MAXSIZE
    """
    return Config(
        collector_url=_env_str("SYNCSPACE_COLLECTOR_URL", DEFAULT_COLLECTOR_URL),
        rules_file=_env_str("SYNCSPACE_RULES_FILE", ""),
        agent_disambiguator=_env_str("SYNCSPACE_AGENT_DISAMBIGUATOR", ""),
        emit_timeout_s=_env_float("SYNCSPACE_EMIT_TIMEOUT_S", DEFAULT_EMIT_TIMEOUT_S),
        queue_maxsize=_env_int("SYNCSPACE_QUEUE_MAXSIZE", DEFAULT_QUEUE_MAXSIZE),
    )
