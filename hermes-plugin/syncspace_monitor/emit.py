"""이벤트 emit — 백그라운드 큐 + urllib POST, fire-and-forget (stdlib only).

설계 (PIVOT emit 전송 규약):
  - hook 경로를 절대 막지 않는다: 이벤트를 큐에 넣고 즉시 반환.
  - 별도 데몬 워커 스레드가 큐를 비우며 urllib로 짧은 타임아웃 POST.
  - 컬렉터 다운/네트워크 실패 = graceful skip (예외 무시, 에이전트 진행 방해 금지).
  - 큐 가득 시 드롭 + 카운터 증가.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import urllib.error
import urllib.request
from typing import Optional

logger = logging.getLogger(__name__)

# 큐 종료 신호.
_SENTINEL = object()


class EventEmitter:
    """비차단 이벤트 송신기.

    단일 데몬 워커 스레드가 큐를 소비한다. emit()은 큐 put_nowait 후 즉시 반환.
    """

    def __init__(
        self,
        ingest_url: str,
        timeout_s: float = 0.2,
        queue_maxsize: int = 1000,
    ) -> None:
        self._url = ingest_url
        self._timeout = timeout_s if timeout_s > 0 else 0.2
        self._queue: "queue.Queue[object]" = queue.Queue(maxsize=max(1, queue_maxsize))
        self._dropped = 0
        self._sent = 0
        self._failed = 0
        self._lock = threading.Lock()
        self._worker: Optional[threading.Thread] = None
        self._started = False
        self._start_lock = threading.Lock()

    # -- 카운터 (관찰/테스트용) ------------------------------------------

    @property
    def dropped(self) -> int:
        with self._lock:
            return self._dropped

    @property
    def sent(self) -> int:
        with self._lock:
            return self._sent

    @property
    def failed(self) -> int:
        with self._lock:
            return self._failed

    # -- 라이프사이클 ----------------------------------------------------

    def _ensure_worker(self) -> None:
        """최초 emit 시 워커 스레드를 지연 기동(lazy start)."""
        if self._started:
            return
        with self._start_lock:
            if self._started:
                return
            t = threading.Thread(
                target=self._run,
                name="syncspace-emit",
                daemon=True,
            )
            t.start()
            self._worker = t
            self._started = True

    def emit(self, event: dict) -> bool:
        """이벤트를 큐에 넣는다. 반환: 큐잉 성공 여부.

        절대 예외를 던지지 않는다. 큐 가득 시 드롭+카운터.
        """
        try:
            self._ensure_worker()
            self._queue.put_nowait(event)
            return True
        except queue.Full:
            with self._lock:
                self._dropped += 1
            return False
        except Exception:
            # 어떤 이유로든 큐잉 실패 → 조용히 드롭(hook 보호).
            with self._lock:
                self._dropped += 1
            return False

    def _run(self) -> None:
        """워커 루프: 큐에서 이벤트를 꺼내 POST."""
        while True:
            item = self._queue.get()
            if item is _SENTINEL:
                self._queue.task_done()
                break
            try:
                self._post(item)
            except Exception:
                # 어떤 송신 실패도 워커를 죽이지 않는다.
                with self._lock:
                    self._failed += 1
            finally:
                self._queue.task_done()

    def _post(self, event: dict) -> None:
        """단일 이벤트를 컬렉터로 POST (실패는 graceful skip)."""
        try:
            body = json.dumps(event).encode("utf-8")
        except (TypeError, ValueError):
            with self._lock:
                self._failed += 1
            return
        req = urllib.request.Request(
            self._url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout):
                pass
            with self._lock:
                self._sent += 1
        except (urllib.error.URLError, OSError, ValueError):
            # 컬렉터 다운/타임아웃/잘못된 URL → 조용히 스킵.
            with self._lock:
                self._failed += 1

    def flush(self, timeout: Optional[float] = None) -> None:
        """큐가 빌 때까지 대기 (주로 테스트/종료용). 비차단 보장 아님."""
        try:
            self._queue.join()
        except Exception:
            pass

    def close(self) -> None:
        """워커에 종료 신호를 보낸다 (graceful)."""
        if not self._started:
            return
        try:
            self._queue.put_nowait(_SENTINEL)
        except Exception:
            pass
