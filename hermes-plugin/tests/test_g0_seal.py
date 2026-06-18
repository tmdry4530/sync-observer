"""G0 봉인 회귀 테스트 — 플러그인이 hermes의 *실제* pre_tool_call kwargs를 처리하는가.

실 계약 (출처: /tmp/hermes-src/hermes_cli/plugins.py
get_pre_tool_call_block_message → invoke_hook("pre_tool_call", ...), hermes v0.16.0):

    tool_name, args(항상 dict), task_id, session_id, tool_call_id, turn_id,
    api_request_id, middleware_trace

핵심: hermes는 pre_tool_call에 cwd / git_branch 를 **전달하지 않는다**(플러그인은
optional로 처리 → null). id 기본값은 "" (빈 문자열). api_request_id /
middleware_trace 는 플러그인이 쓰지 않으므로 **kwargs 로 흡수돼야 한다(크래시 금지).

`hermes hooks test`는 SHELL hook 만 발화시키므로 플러그인 hook 캡처에 쓸 수 없다.
G0 봉인은 (a) 호출부 소스 인용 + (b) 실제 플러그인 코드가 그 kwargs 를 정확히
처리함을 이 테스트로 검증하는 것으로 성립한다.
"""

import os
import unittest

from syncspace_monitor.config import Config
from syncspace_monitor.hooks import Monitor


def _real_pre_tool_call_kwargs(**overrides):
    """hermes 가 plugin pre_tool_call hook 에 넘기는 정확한 kwargs 형태."""
    base = dict(
        tool_name="write_file",
        args={"path": "/tmp/g0_seal.txt", "content": "x"},
        task_id="",
        session_id="sess-real-abc",
        tool_call_id="call-real-123",
        turn_id="turn-real-1",
        api_request_id="req-xyz",
        middleware_trace=[],
    )
    base.update(overrides)
    return base


class _RecEmitter:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)

    def flush(self):
        pass


def _monitor(emitter):
    cfg = Config(
        collector_url="http://127.0.0.1:0",
        rules_file="",
        agent_disambiguator="",
        emit_timeout_s=0.1,
        queue_maxsize=10,
        interrupt_poll_enabled=False,
        interrupt_poll_min_interval_s=0.25,
    )
    return Monitor(config=cfg, emitter=emitter)


class TestG0Seal(unittest.TestCase):
    def test_plugin_processes_real_hermes_kwargs(self):
        emitter = _RecEmitter()
        m = _monitor(emitter)
        ret = m.on_pre_tool_call(**_real_pre_tool_call_kwargs())
        # No rule loaded → default-allow → no block.
        self.assertIsNone(ret)
        self.assertEqual(len(emitter.events), 1)
        ev = emitter.events[0]
        self.assertEqual(ev["action"], "write")
        self.assertEqual(ev["tool"], "write_file")
        # path is realpath-normalized (symlinks resolved); on macOS /tmp → /private/tmp.
        self.assertEqual(ev["paths"], [os.path.realpath("/tmp/g0_seal.txt")])
        self.assertEqual(ev["status"], "started")
        self.assertEqual(ev["sessionId"], "sess-real-abc")
        self.assertEqual(ev["turnId"], "turn-real-1")
        self.assertEqual(ev["correlationId"], "call-real-123")  # tool_call_id → correlationId
        self.assertIsNone(ev["taskId"])  # "" → null
        # hermes does NOT pass cwd / git_branch to pre_tool_call → null.
        self.assertIsNone(ev["cwd"])
        self.assertIsNone(ev["gitBranch"])

    def test_unused_kwargs_absorbed_without_raising(self):
        # api_request_id + middleware_trace (+ a future unknown key) must be
        # swallowed by **kwargs; the hook must never raise on extra context.
        emitter = _RecEmitter()
        m = _monitor(emitter)
        kwargs = _real_pre_tool_call_kwargs(some_future_key={"nested": True})
        ret = m.on_pre_tool_call(**kwargs)
        self.assertIsNone(ret)
        self.assertEqual(len(emitter.events), 1)

    def test_empty_id_strings_become_null(self):
        emitter = _RecEmitter()
        m = _monitor(emitter)
        m.on_pre_tool_call(**_real_pre_tool_call_kwargs(session_id="", turn_id="", tool_call_id=""))
        ev = emitter.events[0]
        self.assertIsNone(ev["sessionId"])
        self.assertIsNone(ev["turnId"])
        self.assertIsNone(ev["correlationId"])


if __name__ == "__main__":
    unittest.main()
