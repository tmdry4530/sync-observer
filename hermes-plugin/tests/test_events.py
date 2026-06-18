"""정규화 이벤트 빌더 단위 테스트 — action 매핑 / paths 추출 / terminal 파서.

LLM·hermes 미설치로도 돈다(순수 stdlib).
extract_raw_paths는 이제 (paths, path_parse_miss) tuple을 반환한다.
parse_terminal_paths는 이제 (paths, had_path_content) tuple을 반환한다.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from syncspace_monitor import events  # noqa: E402


class TestActionMapping(unittest.TestCase):
    def test_basic_map(self):
        self.assertEqual(events._map_action("read_file", {}), "read")
        self.assertEqual(events._map_action("write_file", {}), "write")
        self.assertEqual(events._map_action("patch", {}), "edit")
        self.assertEqual(events._map_action("terminal", {}), "bash")
        self.assertEqual(events._map_action("delegate_task", {}), "task")
        self.assertEqual(events._map_action("unknown_tool", {}), "other")

    def test_search_files_grep_vs_glob(self):
        self.assertEqual(events._map_action("search_files", {"pattern": "x"}), "grep")
        self.assertEqual(
            events._map_action("search_files", {"pattern": "*.py", "target": "files"}),
            "glob",
        )
        self.assertEqual(
            events._map_action("search_files", {"pattern": "x", "file_glob": "*.py"}),
            "glob",
        )


class TestPathExtraction(unittest.TestCase):
    """extract_raw_paths → (list[str], bool) 반환 확인."""

    def _paths(self, tool, args):
        paths, _ = events.extract_raw_paths(tool, args)
        return paths

    def _miss(self, tool, args):
        _, miss = events.extract_raw_paths(tool, args)
        return miss

    def test_read_write_patch_replace(self):
        self.assertEqual(self._paths("read_file", {"path": "/a/b.txt"}), ["/a/b.txt"])
        self.assertEqual(self._paths("write_file", {"path": "/a/c.txt", "content": "x"}), ["/a/c.txt"])
        self.assertEqual(self._paths("patch", {"mode": "replace", "path": "/a/d.py", "old_string": "x", "new_string": "y"}), ["/a/d.py"])

    def test_patch_mode_patch_path_parse_miss(self):
        # mode='patch': path 키 없음 → pathParseMiss=True, paths=[]
        paths, miss = events.extract_raw_paths("patch", {"mode": "patch", "patch": "*** Begin Patch\n*** Update File: foo.py\n*** End Patch"})
        self.assertEqual(paths, [])
        self.assertTrue(miss)

    def test_search_files_explicit_path(self):
        paths, miss = events.extract_raw_paths("search_files", {"pattern": "TODO", "path": "/proj"})
        self.assertEqual(paths, ["/proj"])
        self.assertFalse(miss)

    def test_search_files_missing_path_defaults_to_dot(self):
        # path 미지정 → "." (cwd) 폴백 — pathParseMiss는 False (정상 추출).
        paths, miss = events.extract_raw_paths("search_files", {"pattern": "x"})
        self.assertEqual(paths, ["."])
        self.assertFalse(miss)

    def test_search_files_empty_path_defaults_to_dot(self):
        paths, miss = events.extract_raw_paths("search_files", {"pattern": "x", "path": ""})
        self.assertEqual(paths, ["."])
        self.assertFalse(miss)

    def test_missing_path_first_class_tool_is_miss(self):
        paths, miss = events.extract_raw_paths("read_file", {})
        self.assertEqual(paths, [])
        self.assertTrue(miss)

    def test_none_args_first_class_tool_is_miss(self):
        paths, miss = events.extract_raw_paths("read_file", None)
        self.assertEqual(paths, [])
        self.assertTrue(miss)

    def test_unknown_tool_empty_no_miss(self):
        paths, miss = events.extract_raw_paths("web_search", {"q": "x"})
        self.assertEqual(paths, [])
        self.assertFalse(miss)


class TestTerminalParser(unittest.TestCase):
    """parse_terminal_paths → (list[str], had_path_content) 반환 확인."""

    def _paths(self, cmd):
        paths, _ = events.parse_terminal_paths(cmd)
        return paths

    def _had(self, cmd):
        _, had = events.parse_terminal_paths(cmd)
        return had

    def test_extracts_path_tokens(self):
        self.assertIn("/etc/passwd", self._paths("cat /etc/passwd"))

    def test_drops_options_and_command(self):
        paths = self._paths("rm -rf /tmp/junk")
        self.assertIn("/tmp/junk", paths)
        self.assertNotIn("-rf", paths)
        self.assertNotIn("rm", paths)

    def test_relative_and_tilde(self):
        # ~ 는 parse_terminal_paths 안에서 os.path.expanduser로 전개되므로
        # 결과는 절대경로 (e.g. /Users/chamdom/.ssh/id_rsa).
        import os
        home = os.path.expanduser("~")
        paths = self._paths("cp ~/.ssh/id_rsa ./backup/")
        self.assertTrue(
            any(".ssh/id_rsa" in p for p in paths),
            f"expected .ssh/id_rsa in paths, got {paths}",
        )
        self.assertIn("./backup/", paths)

    def test_shell_meta_strict_excluded(self):
        paths = self._paths("echo $(whoami) > out")
        self.assertNotIn("$(whoami)", paths)

    def test_unbalanced_quotes_returns_empty_had_true(self):
        paths, had = events.parse_terminal_paths('cat "unterminated')
        self.assertEqual(paths, [])
        self.assertTrue(had)  # 명령이 있었으므로 had=True

    def test_non_string_empty(self):
        paths, had = events.parse_terminal_paths(None)
        self.assertEqual(paths, [])
        self.assertFalse(had)
        paths2, had2 = events.parse_terminal_paths(123)
        self.assertEqual(paths2, [])
        self.assertFalse(had2)

    # --- 신규: 변수 정적 전개 ---

    def test_home_var_expansion(self):
        """$HOME 정적 전개 후 경로로 잡힌다."""
        import os
        home = os.environ.get("HOME", "")
        if not home:
            self.skipTest("HOME not set")
        paths = self._paths(f"rm -rf $HOME/.ssh")
        # 전개 후 절대경로가 잡혀야 한다.
        self.assertTrue(any(".ssh" in p for p in paths), f"paths={paths}")

    def test_home_var_braces_expansion(self):
        """${HOME} 전개."""
        import os
        home = os.environ.get("HOME", "")
        if not home:
            self.skipTest("HOME not set")
        paths = self._paths(f'rm -rf "${{HOME}}/.ssh"')
        self.assertTrue(any(".ssh" in p for p in paths), f"paths={paths}")

    def test_glob_prefix_extracted(self):
        """~/.ssh/* → prefix ~/.ssh が잡힌다."""
        paths = self._paths("rm -rf ~/.ssh/*")
        self.assertTrue(
            any(".ssh" in p or p.endswith("/.ssh") for p in paths),
            f"paths={paths}",
        )

    def test_dot_star_prefix(self):
        """./* → prefix '.' 이 잡힌다."""
        paths = self._paths("rm -rf ./*")
        self.assertIn(".", paths)

    def test_dot_single_candidate(self):
        """'.' 단독은 경로 후보 (cwd 삭제 탐지)."""
        paths = self._paths("rm -rf .")
        self.assertIn(".", paths)

    def test_dotdot_single_candidate(self):
        """'..' 단독도 경로 후보."""
        paths = self._paths("rm -rf ..")
        self.assertIn("..", paths)

    def test_home_slash_ssh_slash_star_blocked_by_deny(self):
        """~/.ssh/* glob 명령에서 prefix가 추출되고 deny와 매칭된다(통합)."""
        import os
        from syncspace_monitor.rules import normalize_path, glob_match
        home = os.environ.get("HOME", "")
        if not home:
            self.skipTest("HOME not set")
        paths = self._paths("rm -rf ~/.ssh/*")
        # 적어도 하나의 경로가 .ssh 디렉터리를 가리켜야 한다.
        self.assertTrue(any(".ssh" in p for p in paths), f"paths={paths}")


class TestAgentId(unittest.TestCase):
    def test_explicit_disambiguator(self):
        self.assertEqual(events.derive_agent_id("sess123", "mybox"), "hermes:mybox")

    def test_session_prefix(self):
        self.assertEqual(events.derive_agent_id("abcdefghijklmnop"), "hermes:abcdefghijkl")

    def test_unknown(self):
        self.assertEqual(events.derive_agent_id(None), "hermes:unknown")
        self.assertEqual(events.derive_agent_id(""), "hermes:unknown")


class TestBuildEvent(unittest.TestCase):
    def test_schema_fields_present(self):
        ev = events.build_event(
            tool_name="read_file",
            args={"path": "/a/b.txt"},
            status="started",
            session_id="S1",
            task_id="T1",
            turn_id="U1",
            tool_call_id="C1",
        )
        for key in (
            "v", "eventId", "ts", "agentId", "agentKind", "sessionId", "taskId",
            "turnId", "action", "tool", "paths", "status", "cwd", "gitBranch",
            "correlationId", "summary", "detail", "visibleToUser",
        ):
            self.assertIn(key, ev)
        self.assertEqual(ev["v"], 1)
        self.assertEqual(ev["agentKind"], "hermes")
        self.assertEqual(ev["action"], "read")
        self.assertEqual(ev["tool"], "read_file")
        self.assertEqual(ev["paths"], ["/a/b.txt"])
        self.assertEqual(ev["status"], "started")
        self.assertEqual(ev["correlationId"], "C1")
        self.assertEqual(ev["agentId"], "hermes:S1")
        self.assertTrue(ev["visibleToUser"])

    def test_ts_format_iso_ms_z(self):
        ev = events.build_event(tool_name="read_file", args={"path": "/x"}, status="started")
        self.assertTrue(ev["ts"].endswith("Z"))
        self.assertIn("T", ev["ts"])
        self.assertIn(".", ev["ts"])

    def test_nullable_fields(self):
        ev = events.build_event(tool_name="read_file", args={"path": "/x"}, status="started")
        self.assertIsNone(ev["taskId"])
        self.assertIsNone(ev["turnId"])
        self.assertIsNone(ev["cwd"])
        self.assertIsNone(ev["gitBranch"])

    def test_terminal_detail_has_command(self):
        ev = events.build_event(
            tool_name="terminal", args={"command": "ls /tmp"}, status="started"
        )
        self.assertEqual(ev["action"], "bash")
        self.assertIsNotNone(ev["detail"])
        self.assertEqual(ev["detail"]["command"], "ls /tmp")
        self.assertIn("/tmp", ev["paths"])

    def test_search_detail_has_pattern(self):
        ev = events.build_event(
            tool_name="search_files",
            args={"pattern": "TODO", "path": "/proj"},
            status="started",
        )
        self.assertEqual(ev["action"], "grep")
        self.assertEqual(ev["detail"]["pattern"], "TODO")
        self.assertEqual(ev["paths"], ["/proj"])

    def test_search_files_no_path_uses_dot(self):
        """path 미지정 시 '.'이 경로로 잡힌다."""
        ev = events.build_event(
            tool_name="search_files",
            args={"pattern": "TODO"},
            status="started",
        )
        self.assertIn(".", ev["paths"])

    def test_patch_mode_patch_has_path_parse_miss_flag(self):
        """mode='patch' (V4A 멀티파일) → detail.pathParseMiss=True."""
        ev = events.build_event(
            tool_name="patch",
            args={"mode": "patch", "patch": "*** Begin Patch\n*** End Patch"},
            status="started",
        )
        self.assertIsNotNone(ev["detail"])
        self.assertTrue(ev["detail"].get("pathParseMiss"))

    def test_normalize_fn_applied(self):
        def fake_norm(p, cwd):
            return "/normalized" + p

        ev = events.build_event(
            tool_name="read_file",
            args={"path": "/a"},
            status="started",
            normalize_fn=fake_norm,
        )
        self.assertEqual(ev["paths"], ["/normalized/a"])

    def test_normalize_fn_failure_raw_fallback_and_flag(self):
        """정규화 실패 시 raw 경로 유지 + detail.normalizeFailed=True."""
        def bad_norm(p, cwd):
            return None

        ev = events.build_event(
            tool_name="read_file",
            args={"path": "/some/path.txt"},
            status="started",
            normalize_fn=bad_norm,
        )
        self.assertEqual(ev["paths"], ["/some/path.txt"])  # raw 폴백
        self.assertIsNotNone(ev["detail"])
        self.assertTrue(ev["detail"].get("normalizeFailed"))

    def test_detail_extra_merged(self):
        ev = events.build_event(
            tool_name="write_file",
            args={"path": "/a", "content": "x"},
            status="blocked",
            detail_extra={"intervention": {"ruleId": "r1", "mode": "block"}},
        )
        self.assertEqual(ev["detail"]["intervention"]["ruleId"], "r1")
        self.assertTrue(ev["summary"].startswith("blocked:"))


class TestPostStatusMapping(unittest.TestCase):
    """post_tool_call의 ok→success 명시 분기, 미지값 rawStatus 보존."""

    def _get_status(self, raw):
        from syncspace_monitor.hooks import _POST_STATUS_MAP
        raw_str = raw.lower() if isinstance(raw, str) else None
        return _POST_STATUS_MAP.get(raw_str)

    def test_ok_maps_to_success(self):
        self.assertEqual(self._get_status("ok"), "success")

    def test_success_maps_to_success(self):
        self.assertEqual(self._get_status("success"), "success")

    def test_error_variants(self):
        self.assertEqual(self._get_status("error"), "error")
        self.assertEqual(self._get_status("failed"), "error")
        self.assertEqual(self._get_status("failure"), "error")

    def test_cancelled_variants(self):
        self.assertEqual(self._get_status("cancelled"), "cancelled")
        self.assertEqual(self._get_status("canceled"), "cancelled")

    def test_blocked(self):
        self.assertEqual(self._get_status("blocked"), "blocked")

    def test_unknown_not_in_map(self):
        self.assertIsNone(self._get_status("running"))


if __name__ == "__main__":
    unittest.main()
