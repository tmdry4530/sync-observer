"""M5 수동중지 폴 → in-process interrupt 단위 테스트 (stdlib unittest).

hermes 미설치로도 돈다:
  - interrupt_resolver는 fake를 주입(실제 set_interrupt 호출 없음).
  - pending 폴은 poll_fn 주입으로 가로채(네트워크/hermes 없음).
emit는 _FakeEmitter로 가로챈다.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from syncspace_monitor.config import Config  # noqa: E402
from syncspace_monitor.hooks import Monitor  # noqa: E402
from syncspace_monitor.rules import Rule, evaluate as _eval  # noqa: E402


class _FakeEmitter:
    def __init__(self):
        self.events = []

    def emit(self, event):
        self.events.append(event)
        return True


class _StubRuleStore:
    def __init__(self, rules):
        self._rules = rules

    def evaluate(self, path, session_id=None, agent_id=None):
        return _eval(self._rules, path, session_id, agent_id)


class _SpyResolver:
    """interrupt_resolver fake — 호출 횟수/인자 기록."""

    def __init__(self):
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return None


def _make_monitor(
    rules_list=None,
    *,
    poll_fn=None,
    interrupt_resolver=None,
    poll_enabled=True,
    poll_interval=0.5,
):
    cfg = Config(
        collector_url="http://127.0.0.1:9",
        rules_file="",
        agent_disambiguator="test",
        emit_timeout_s=0.05,
        queue_maxsize=10,
        interrupt_poll_enabled=poll_enabled,
        interrupt_poll_min_interval_s=poll_interval,
    )
    emitter = _FakeEmitter()
    mon = Monitor(
        config=cfg,
        rule_store=_StubRuleStore(rules_list or []),
        emitter=emitter,
        interrupt_resolver=interrupt_resolver,
        poll_fn=poll_fn,
    )
    return mon, emitter


def _abs(p):
    from syncspace_monitor.rules import normalize_path
    return normalize_path(p)


# ---------------------------------------------------------------------------
# pending 폴 → block + resolver 호출
# ---------------------------------------------------------------------------

class TestPendingPollBlocks(unittest.TestCase):
    def test_pending_interrupt_blocks_and_calls_resolver(self):
        """pending이 interrupt 1건 반환 → block dict + resolver 1회 호출."""
        resolver = _SpyResolver()
        poll_calls = []

        def fake_poll(agent_id, session_id):
            poll_calls.append((agent_id, session_id))
            return {
                "interrupts": [
                    {"id": 7, "reason": "user stop", "createdAt": "2026-06-18T00:00:00Z"}
                ]
            }

        mon, emitter = _make_monitor(
            poll_fn=fake_poll, interrupt_resolver=resolver
        )
        out = mon.on_pre_tool_call(
            tool_name="read_file",
            args={"path": "/tmp/allowed/ok.txt"},
            session_id="S1",
        )
        self.assertIsInstance(out, dict)
        self.assertEqual(out["action"], "block")
        self.assertIn("SyncSpace manual interrupt", out["message"])
        self.assertIn("user stop", out["message"])
        # resolver 정확히 1회 호출 + reason 전달.
        self.assertEqual(len(resolver.calls), 1)
        self.assertEqual(resolver.calls[0].get("reason"), "user stop")
        # 폴은 1회 수행.
        self.assertEqual(len(poll_calls), 1)
        # 블록 캡처 emit은 detail.intervention 없음(중복 감사 방지).
        blocked = [e for e in emitter.events if e["status"] == "blocked"]
        self.assertTrue(blocked)
        self.assertNotIn("intervention", blocked[0].get("detail") or {})

    def test_pending_interrupt_null_reason_message(self):
        """reason=null → 메시지는 접미사 없이 'SyncSpace manual interrupt'."""
        resolver = _SpyResolver()

        def fake_poll(agent_id, session_id):
            return {"interrupts": [{"id": 1, "reason": None, "createdAt": "x"}]}

        mon, _ = _make_monitor(poll_fn=fake_poll, interrupt_resolver=resolver)
        out = mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/ok.txt"}, session_id="S1"
        )
        self.assertEqual(out["action"], "block")
        self.assertEqual(out["message"], "SyncSpace manual interrupt")
        self.assertEqual(len(resolver.calls), 1)
        self.assertIsNone(resolver.calls[0].get("reason"))


# ---------------------------------------------------------------------------
# empty pending → no block
# ---------------------------------------------------------------------------

class TestEmptyPending(unittest.TestCase):
    def test_empty_interrupts_no_block_no_resolver(self):
        resolver = _SpyResolver()

        def fake_poll(agent_id, session_id):
            return {"interrupts": []}

        mon, emitter = _make_monitor(poll_fn=fake_poll, interrupt_resolver=resolver)
        out = mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/ok.txt"}, session_id="S1"
        )
        self.assertIsNone(out)
        self.assertEqual(len(resolver.calls), 0)
        # 정상 started emit.
        self.assertTrue(any(e["status"] == "started" for e in emitter.events))

    def test_missing_interrupts_key_no_block(self):
        resolver = _SpyResolver()

        def fake_poll(agent_id, session_id):
            return {}  # interrupts 키 자체 없음.

        mon, _ = _make_monitor(poll_fn=fake_poll, interrupt_resolver=resolver)
        out = mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/ok.txt"}, session_id="S1"
        )
        self.assertIsNone(out)
        self.assertEqual(len(resolver.calls), 0)


# ---------------------------------------------------------------------------
# 스로틀 — 빠른 2회 호출 → 폴 1회만
# ---------------------------------------------------------------------------

class TestPollThrottle(unittest.TestCase):
    def test_two_rapid_calls_poll_once(self):
        """min_interval 안의 연속 2회 → 폴 1회만(2번째는 스로틀)."""
        resolver = _SpyResolver()
        poll_calls = []

        def fake_poll(agent_id, session_id):
            poll_calls.append((agent_id, session_id))
            return {"interrupts": []}

        # 큰 interval로 2번째 호출이 확실히 스로틀되게.
        mon, _ = _make_monitor(
            poll_fn=fake_poll, interrupt_resolver=resolver, poll_interval=100.0
        )
        mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/a.txt"}, session_id="S1"
        )
        mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/b.txt"}, session_id="S1"
        )
        self.assertEqual(len(poll_calls), 1)

    def test_zero_interval_polls_each_call(self):
        """interval=0 → 매 호출 폴 허용."""
        poll_calls = []

        def fake_poll(agent_id, session_id):
            poll_calls.append(1)
            return {"interrupts": []}

        mon, _ = _make_monitor(poll_fn=fake_poll, poll_interval=0.0)
        mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/a.txt"}, session_id="S1"
        )
        mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/b.txt"}, session_id="S1"
        )
        self.assertEqual(len(poll_calls), 2)


# ---------------------------------------------------------------------------
# 폴 예외 → fail-open
# ---------------------------------------------------------------------------

class TestPollFailOpen(unittest.TestCase):
    def test_poll_raises_no_block_no_exception(self):
        resolver = _SpyResolver()

        def boom_poll(agent_id, session_id):
            raise RuntimeError("network down")

        mon, emitter = _make_monitor(poll_fn=boom_poll, interrupt_resolver=resolver)
        # 예외가 hook 밖으로 새어나가면 안 됨.
        out = mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/ok.txt"}, session_id="S1"
        )
        self.assertIsNone(out)
        self.assertEqual(len(resolver.calls), 0)
        # 정상 started emit 유지.
        self.assertTrue(any(e["status"] == "started" for e in emitter.events))

    def test_poll_returns_non_dict_no_block(self):
        resolver = _SpyResolver()

        def weird_poll(agent_id, session_id):
            return None  # 폴 실패(http_poll None 반환 모사).

        mon, _ = _make_monitor(poll_fn=weird_poll, interrupt_resolver=resolver)
        out = mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/ok.txt"}, session_id="S1"
        )
        self.assertIsNone(out)
        self.assertEqual(len(resolver.calls), 0)


# ---------------------------------------------------------------------------
# poll 비활성 → 폴 안 함
# ---------------------------------------------------------------------------

class TestPollDisabled(unittest.TestCase):
    def test_disabled_never_polls(self):
        resolver = _SpyResolver()
        poll_calls = []

        def fake_poll(agent_id, session_id):
            poll_calls.append(1)
            return {"interrupts": [{"id": 1, "reason": "x", "createdAt": "y"}]}

        mon, _ = _make_monitor(
            poll_fn=fake_poll, interrupt_resolver=resolver, poll_enabled=False
        )
        out = mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/ok.txt"}, session_id="S1"
        )
        self.assertIsNone(out)
        self.assertEqual(len(poll_calls), 0)
        self.assertEqual(len(resolver.calls), 0)


# ---------------------------------------------------------------------------
# 규칙 pre-block이 폴보다 우선
# ---------------------------------------------------------------------------

class TestRuleBlockPrecedence(unittest.TestCase):
    def test_deny_match_blocks_without_polling(self):
        """deny 매치는 폴 없이 즉시 차단(폴 함수 호출 안 됨)."""
        resolver = _SpyResolver()
        poll_calls = []

        def fake_poll(agent_id, session_id):
            poll_calls.append(1)
            return {"interrupts": [{"id": 9, "reason": "z", "createdAt": "w"}]}

        deny_glob = _abs("/tmp/ss-m5-deny") + "/**"
        mon, _ = _make_monitor(
            [Rule(id="d1", kind="deny", glob=deny_glob)],
            poll_fn=fake_poll,
            interrupt_resolver=resolver,
        )
        out = mon.on_pre_tool_call(
            tool_name="write_file",
            args={"path": "/tmp/ss-m5-deny/x", "content": "y"},
            session_id="S1",
        )
        self.assertIsInstance(out, dict)
        self.assertEqual(out["action"], "block")
        # 규칙 메시지(폴 메시지 아님).
        self.assertIn("SyncSpace blocked write_file", out["message"])
        self.assertIn("rule: d1", out["message"])
        # 폴/리졸버 미호출.
        self.assertEqual(len(poll_calls), 0)
        self.assertEqual(len(resolver.calls), 0)


# ---------------------------------------------------------------------------
# 기본 resolver — hermes 부재 시 no-op (예외 없음)
# ---------------------------------------------------------------------------

class TestDefaultResolverSafe(unittest.TestCase):
    def test_default_resolver_no_hermes_is_safe(self):
        """tools.interrupt 부재 환경에서 기본 resolver는 None 반환 + 무예외."""
        from syncspace_monitor.hooks import _default_interrupt_resolver

        # hermes가 없으면 ImportError 흡수 → None.
        self.assertIsNone(_default_interrupt_resolver(reason="x", session_id="S1"))

    def test_default_resolver_triggers_set_interrupt_when_available(self):
        """tools.interrupt가 있으면 set_interrupt(True)를 현재 스레드로 호출한다."""
        import types

        calls = []
        fake_mod = types.ModuleType("tools.interrupt")

        def _set_interrupt(active, thread_id=None):
            calls.append((active, thread_id))

        fake_mod.set_interrupt = _set_interrupt
        tools_pkg = types.ModuleType("tools")
        tools_pkg.interrupt = fake_mod

        saved_tools = sys.modules.get("tools")
        saved_int = sys.modules.get("tools.interrupt")
        sys.modules["tools"] = tools_pkg
        sys.modules["tools.interrupt"] = fake_mod
        try:
            from syncspace_monitor.hooks import _default_interrupt_resolver

            self.assertIsNone(_default_interrupt_resolver(reason="x"))
            self.assertEqual(calls, [(True, None)])
        finally:
            if saved_tools is not None:
                sys.modules["tools"] = saved_tools
            else:
                sys.modules.pop("tools", None)
            if saved_int is not None:
                sys.modules["tools.interrupt"] = saved_int
            else:
                sys.modules.pop("tools.interrupt", None)


if __name__ == "__main__":
    unittest.main()
