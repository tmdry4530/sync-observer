"""pre-block 결정 + 회귀 단위 테스트 — Monitor.on_pre_tool_call 직접 호출.

hermes 미설치로도 돈다: hook 계약을 우리 함수 시그니처로 모사.
emit는 _FakeEmitter로 가로채 네트워크 없음.
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


def _make_monitor(rules_list):
    cfg = Config(
        collector_url="http://127.0.0.1:9",
        rules_file="",
        agent_disambiguator="test",
        emit_timeout_s=0.05,
        queue_maxsize=10,
    )
    emitter = _FakeEmitter()
    mon = Monitor(
        config=cfg,
        rule_store=_StubRuleStore(rules_list),
        emitter=emitter,
    )
    return mon, emitter


def _abs(p):
    from syncspace_monitor.rules import normalize_path
    return normalize_path(p)


# ---------------------------------------------------------------------------
# 1급 파일 툴 pre-block
# ---------------------------------------------------------------------------

class TestPreBlockFileTools(unittest.TestCase):
    def test_blocks_denied_write_file(self):
        deny_glob = _abs("/tmp/syncspace-secret") + "/**"
        mon, emitter = _make_monitor([Rule(id="d1", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="write_file",
            args={"path": "/tmp/syncspace-secret/x", "content": "y"},
            session_id="S1",
        )
        self.assertIsInstance(out, dict)
        self.assertEqual(out["action"], "block")
        self.assertIn("SyncSpace blocked write_file", out["message"])
        self.assertIn("rule: d1", out["message"])
        blocked = [e for e in emitter.events if e["status"] == "blocked"]
        self.assertTrue(blocked)
        self.assertEqual(blocked[0]["detail"]["intervention"]["trigger"], "auto")
        self.assertEqual(blocked[0]["detail"]["intervention"]["mode"], "block")

    def test_blocks_read_file(self):
        deny_glob = _abs("/tmp/ss-deny") + "/**"
        mon, _ = _make_monitor([Rule(id="r2", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/tmp/ss-deny/secret.txt"}
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")

    def test_blocks_search_files_explicit_path(self):
        deny_glob = _abs("/tmp/ss-deny2") + "/**"
        mon, _ = _make_monitor([Rule(id="r3", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="search_files",
            args={"pattern": "key", "path": "/tmp/ss-deny2/sub"},
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")

    def test_allows_non_matching(self):
        deny_glob = _abs("/tmp/ss-deny3") + "/**"
        mon, emitter = _make_monitor([Rule(id="r4", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="write_file",
            args={"path": "/tmp/allowed/ok.txt", "content": "z"},
        )
        self.assertIsNone(out)
        self.assertTrue(any(e["status"] == "started" for e in emitter.events))

    def test_empty_rules_allows(self):
        mon, emitter = _make_monitor([])
        out = mon.on_pre_tool_call(
            tool_name="write_file", args={"path": "/tmp/anything", "content": "z"}
        )
        self.assertIsNone(out)
        self.assertTrue(any(e["status"] == "started" for e in emitter.events))


# ---------------------------------------------------------------------------
# search_files 기본값 "." — HIGH
# ---------------------------------------------------------------------------

class TestSearchFilesDefault(unittest.TestCase):
    def test_search_files_missing_path_uses_dot(self):
        """path 미지정 시 '.'(cwd)로 폴백되어 정규화 후 deny와 매칭된다."""
        cwd = os.getcwd()
        from syncspace_monitor.rules import normalize_path
        dot_norm = normalize_path(".", cwd)
        # cwd가 deny 서브트리 안에 없으면 그냥 allow 확인.
        mon, emitter = _make_monitor([])
        out = mon.on_pre_tool_call(
            tool_name="search_files",
            args={"pattern": "TODO"},  # path 없음
        )
        self.assertIsNone(out)  # 규칙 없음 → allow
        started = [e for e in emitter.events if e["status"] == "started"]
        self.assertTrue(started)
        # paths가 비어 있지 않아야 한다("." → 정규화된 경로).
        self.assertTrue(len(started[0]["paths"]) > 0)

    def test_search_files_no_path_deny_cwd(self):
        """cwd가 deny 서브트리 안이면 path 미지정 search_files도 차단된다."""
        cwd = os.getcwd()
        from syncspace_monitor.rules import normalize_path
        cwd_norm = normalize_path(".", cwd)
        if cwd_norm is None:
            self.skipTest("cwd normalize failed")
        # cwd 자체를 deny 서브트리로 만드는 glob.
        deny_glob = cwd_norm + "/**"
        mon, _ = _make_monitor([Rule(id="cwd1", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="search_files",
            args={"pattern": "TODO"},
            cwd=cwd,
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")


# ---------------------------------------------------------------------------
# patch mode='patch' pathParseMiss — HIGH
# ---------------------------------------------------------------------------

class TestPatchModeParseMiss(unittest.TestCase):
    def test_patch_mode_no_path_emits_path_parse_miss(self):
        """mode='patch' (V4A 멀티파일): path 없음 → started emit + pathParseMiss=True."""
        mon, emitter = _make_monitor([])
        out = mon.on_pre_tool_call(
            tool_name="patch",
            args={"mode": "patch", "patch": "*** Begin Patch\n*** End Patch"},
        )
        self.assertIsNone(out)  # 차단 안 함(기본 allow).
        started = [e for e in emitter.events if e["status"] == "started"]
        self.assertTrue(started)
        self.assertTrue(started[0]["detail"].get("pathParseMiss"))

    def test_patch_mode_replace_has_path_no_miss(self):
        """mode='replace': path 있음 → pathParseMiss 없음."""
        mon, emitter = _make_monitor([])
        mon.on_pre_tool_call(
            tool_name="patch",
            args={"mode": "replace", "path": "/tmp/x.py", "old_string": "a", "new_string": "b"},
        )
        started = [e for e in emitter.events if e["status"] == "started"]
        self.assertTrue(started)
        self.assertFalse(started[0].get("detail", {}).get("pathParseMiss", False))


# ---------------------------------------------------------------------------
# terminal 변수확장 + glob prefix + 단독점 — HIGH
# ---------------------------------------------------------------------------

class TestTerminalVarExpansionBlock(unittest.TestCase):
    def _home(self):
        return os.environ.get("HOME", "")

    def test_home_var_blocks(self):
        """$HOME/.ssh 가 expand되어 deny에 걸린다."""
        home = self._home()
        if not home:
            self.skipTest("HOME not set")
        from syncspace_monitor.rules import normalize_path
        ssh_norm = normalize_path(home + "/.ssh")
        if ssh_norm is None:
            self.skipTest("normalize failed")
        deny_glob = ssh_norm + "/**"
        mon, _ = _make_monitor([Rule(id="h1", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="terminal",
            args={"command": "rm -rf $HOME/.ssh"},
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")

    def test_home_braces_var_blocks(self):
        """${HOME}/.ssh 도 expand되어 deny에 걸린다."""
        home = self._home()
        if not home:
            self.skipTest("HOME not set")
        from syncspace_monitor.rules import normalize_path
        ssh_norm = normalize_path(home + "/.ssh")
        if ssh_norm is None:
            self.skipTest("normalize failed")
        deny_glob = ssh_norm + "/**"
        mon, _ = _make_monitor([Rule(id="h2", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="terminal",
            args={"command": 'rm -rf "${HOME}/.ssh"'},
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")

    def test_tilde_ssh_glob_prefix_blocks(self):
        """~/.ssh/* → prefix ~/.ssh がdenied."""
        home = self._home()
        if not home:
            self.skipTest("HOME not set")
        from syncspace_monitor.rules import normalize_path
        ssh_norm = normalize_path("~/.ssh")
        if ssh_norm is None:
            self.skipTest("normalize failed")
        deny_glob = ssh_norm + "/**"
        mon, _ = _make_monitor([Rule(id="h3", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="terminal",
            args={"command": "rm -rf ~/.ssh/*"},
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")

    def test_dot_star_prefix_dot_extracted(self):
        """`./*` → prefix '.' が경路 후보."""
        from syncspace_monitor.events import parse_terminal_paths
        paths, _ = parse_terminal_paths("rm -rf ./*")
        self.assertIn(".", paths)

    def test_dot_single_candidate(self):
        """'rm -rf .' → '.' が경로 후보."""
        from syncspace_monitor.events import parse_terminal_paths
        paths, _ = parse_terminal_paths("rm -rf .")
        self.assertIn(".", paths)

    def test_dotdot_candidate(self):
        """'..' 도 경로 후보."""
        from syncspace_monitor.events import parse_terminal_paths
        paths, _ = parse_terminal_paths("rm -rf ..")
        self.assertIn("..", paths)


# ---------------------------------------------------------------------------
# 대소문자 무시 FS — pre-block 통합
# ---------------------------------------------------------------------------

class TestCaseInsensitivePreBlock(unittest.TestCase):
    def test_ci_mode_upper_path_blocked(self):
        """CI 모드에서 대소문자 변형 경로가 deny에 걸린다.

        macOS에서 /tmp → /private/tmp symlink가 있으므로, deny glob과 입력 경로
        양쪽을 실제 realpath 기준으로 구성한다. glob은 소문자로 고정하고,
        경로는 같은 realpath prefix에 대소문자를 섞어 CI 매칭을 검증한다.
        """
        import syncspace_monitor.rules as r_mod
        from syncspace_monitor.rules import normalize_path
        original = r_mod._CASE_INSENSITIVE_FS
        try:
            r_mod._CASE_INSENSITIVE_FS = True
            # realpath 기준 deny glob (소문자).
            base_norm = normalize_path("/tmp/ss-ci-deny")
            if base_norm is None:
                self.skipTest("normalize failed")
            deny_glob = base_norm + "/**"
            mon, _ = _make_monitor([Rule(id="ci1", kind="deny", glob=deny_glob)])
            # 대소문자 변형 입력: base의 마지막 세그먼트를 대문자로.
            # base_norm 예: /private/tmp/ss-ci-deny
            # 대소문자 변형 경로를 직접 만든다.
            upper_path = base_norm.upper() + "/secret.txt"
            out = mon.on_pre_tool_call(
                tool_name="write_file",
                args={"path": upper_path, "content": "x"},
            )
            self.assertIsNotNone(out)
            self.assertEqual(out["action"], "block")
        finally:
            r_mod._CASE_INSENSITIVE_FS = original


# ---------------------------------------------------------------------------
# NFC/NFD 우회 — pre-block 통합
# ---------------------------------------------------------------------------

class TestUnicodePreBlock(unittest.TestCase):
    def test_nfd_path_blocked_by_nfc_deny(self):
        """NFC deny glob이 NFD 경로를 차단한다.

        normalize_path는 realpath를 거치므로, 테스트 glob도
        동일한 realpath prefix를 써야 한다.
        macOS: /tmp → /private/tmp이므로 realpath 기준으로 구성.
        """
        import unicodedata
        from syncspace_monitor.rules import normalize_path

        # realpath 기반 prefix 획득 (예: /private/tmp).
        tmp_real = normalize_path("/tmp")  # e.g. /private/tmp on macOS
        if tmp_real is None:
            tmp_real = "/tmp"
        # NFC 디렉터리명
        dir_nfc = unicodedata.normalize("NFC", "café")
        dir_nfd = unicodedata.normalize("NFD", "café")

        # deny glob: NFC glob (realpath prefix 사용).
        nfc_glob = tmp_real + "/" + dir_nfc + "/**"

        # 입력 경로: NFD 형태 (normalize_path 후 NFC로 변환됨).
        nfd_path = "/tmp/" + dir_nfd + "/secret.txt"

        mon, _ = _make_monitor([Rule(id="u1", kind="deny", glob=nfc_glob)])
        out = mon.on_pre_tool_call(
            tool_name="read_file",
            args={"path": nfd_path},
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")


# ---------------------------------------------------------------------------
# normalize_path 실패 — raw 폴백 + normalizeFailed 가시화
# ---------------------------------------------------------------------------

class TestNormalizeFailedFallback(unittest.TestCase):
    def test_normalize_failure_is_fail_open_with_flag(self):
        """정규화 실패 시 블록 안 하고 detail.normalizeFailed=True."""
        from syncspace_monitor.hooks import Monitor
        from syncspace_monitor.rules import RuleStore

        cfg = Config("http://127.0.0.1:9", "", "t", 0.05, 10)
        emitter = _FakeEmitter()

        class _FailNormMonitor(Monitor):
            def _build(self, *, tool_name, args, status, kwargs, detail_extra=None):
                # normalize_fn을 항상 None 반환으로 교체.
                from syncspace_monitor import events as _ev
                return _ev.build_event(
                    tool_name=tool_name,
                    args=args,
                    status=status,
                    session_id=kwargs.get("session_id"),
                    normalize_fn=lambda p, cwd: None,  # 항상 실패.
                    detail_extra=detail_extra,
                )

        mon = _FailNormMonitor(
            config=cfg,
            rule_store=_StubRuleStore([]),
            emitter=emitter,
        )
        out = mon.on_pre_tool_call(
            tool_name="read_file", args={"path": "/some/path.txt"}
        )
        self.assertIsNone(out)  # fail-open: 블록 안 함.
        started = [e for e in emitter.events if e["status"] == "started"]
        self.assertTrue(started)
        self.assertTrue(started[0]["detail"].get("normalizeFailed"))
        # raw 경로가 보존된다.
        self.assertIn("/some/path.txt", started[0]["paths"])


# ---------------------------------------------------------------------------
# post_tool_call — ok→success, rawStatus 보존
# ---------------------------------------------------------------------------

class TestPostToolCallStatus(unittest.TestCase):
    def test_ok_maps_to_success(self):
        mon, emitter = _make_monitor([])
        mon.on_post_tool_call(
            tool_name="read_file", args={"path": "/x"}, result="ok", status="ok"
        )
        emitted = [e for e in emitter.events if e["action"] == "read"]
        self.assertTrue(emitted)
        self.assertEqual(emitted[0]["status"], "success")

    def test_error_status(self):
        mon, emitter = _make_monitor([])
        mon.on_post_tool_call(
            tool_name="read_file", args={"path": "/x"}, result="", status="error"
        )
        self.assertTrue(any(e["status"] == "error" for e in emitter.events))

    def test_unknown_status_absorbed_as_success_with_raw(self):
        """미지 status → success 흡수 + detail.rawStatus 보존."""
        mon, emitter = _make_monitor([])
        mon.on_post_tool_call(
            tool_name="read_file", args={"path": "/x"}, result="", status="running"
        )
        ev = [e for e in emitter.events if e["action"] == "read"]
        self.assertTrue(ev)
        self.assertEqual(ev[0]["status"], "success")
        self.assertEqual(ev[0]["detail"]["rawStatus"], "running")

    def test_none_status_absorbed_as_success(self):
        mon, emitter = _make_monitor([])
        mon.on_post_tool_call(
            tool_name="read_file", args={"path": "/x"}, result="", status=None
        )
        ev = [e for e in emitter.events if e["action"] == "read"]
        self.assertTrue(ev)
        self.assertEqual(ev[0]["status"], "success")


# ---------------------------------------------------------------------------
# 안전성 / fail-open
# ---------------------------------------------------------------------------

class TestFailSafety(unittest.TestCase):
    def test_no_exception_on_bad_args(self):
        mon, _ = _make_monitor([])
        self.assertIsNone(mon.on_pre_tool_call(tool_name="read_file", args=None))
        self.assertIsNone(mon.on_pre_tool_call(tool_name="read_file", args="weird"))
        self.assertIsNone(mon.on_pre_tool_call(tool_name="", args={}))

    def test_rule_eval_failure_is_fail_open(self):
        class _Boom:
            def evaluate(self, *a, **k):
                raise RuntimeError("boom")

        cfg = Config("http://127.0.0.1:9", "", "t", 0.05, 10)
        mon = Monitor(config=cfg, rule_store=_Boom(), emitter=_FakeEmitter())
        out = mon.on_pre_tool_call(
            tool_name="write_file", args={"path": "/x", "content": "y"}
        )
        self.assertIsNone(out)

    def test_interrupt_resolver_default_noop(self):
        mon, _ = _make_monitor([])
        self.assertIsNone(mon.interrupt_resolver(session_id="S1"))


# ---------------------------------------------------------------------------
# terminal pre-block
# ---------------------------------------------------------------------------

class TestPreBlockTerminal(unittest.TestCase):
    def test_blocks_terminal_when_path_parsed(self):
        deny_glob = _abs("/tmp/ss-tdeny") + "/**"
        mon, emitter = _make_monitor([Rule(id="t1", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="terminal",
            args={"command": "rm -rf /tmp/ss-tdeny/data"},
        )
        self.assertIsNotNone(out)
        self.assertEqual(out["action"], "block")
        self.assertIn("terminal", out["message"])

    def test_terminal_no_path_not_blocked(self):
        deny_glob = _abs("/tmp/ss-tdeny2") + "/**"
        mon, _ = _make_monitor([Rule(id="t2", kind="deny", glob=deny_glob)])
        out = mon.on_pre_tool_call(
            tool_name="terminal", args={"command": "echo hello"}
        )
        self.assertIsNone(out)


# ---------------------------------------------------------------------------
# subagent 관찰
# ---------------------------------------------------------------------------

class TestSubagentObservation(unittest.TestCase):
    def test_subagent_start_emits(self):
        mon, emitter = _make_monitor([])
        mon.on_subagent_start(parent_session_id="P1", parent_turn_id="T1")
        self.assertTrue(len(emitter.events) >= 1)
        self.assertEqual(emitter.events[-1]["action"], "task")

    def test_subagent_stop_emits(self):
        mon, emitter = _make_monitor([])
        mon.on_subagent_stop(
            parent_session_id="P1",
            child_role="worker",
            child_status="ok",
            duration_ms=99,
        )
        self.assertTrue(len(emitter.events) >= 1)
        self.assertEqual(emitter.events[-1]["detail"]["childRole"], "worker")


if __name__ == "__main__":
    unittest.main()
