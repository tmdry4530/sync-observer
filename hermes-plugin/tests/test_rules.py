"""규칙엔진 단위 테스트 — glob 매처 / 정규화 / deny-overrides / scope / RuleStore.
대소문자 무시 FS / NFC-NFD 우회 방어 / mtime 리로드 레이스 포함.

LLM·hermes 미설치로도 돈다(순수 stdlib).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from syncspace_monitor import rules  # noqa: E402
from syncspace_monitor.rules import (  # noqa: E402
    Rule, RuleStore, evaluate, glob_match, _compile_glob, _nfc,
)


# ---------------------------------------------------------------------------
# glob 매처
# ---------------------------------------------------------------------------

class TestGlobMatch(unittest.TestCase):
    def test_double_star_crosses_separators(self):
        self.assertTrue(glob_match("/Users/me/.ssh/**", "/Users/me/.ssh/id_rsa"))
        self.assertTrue(
            glob_match("/Users/me/.ssh/**", "/Users/me/.ssh/keys/deploy/id_ed25519")
        )

    def test_double_star_matches_zero_segments(self):
        self.assertTrue(glob_match("/etc/**", "/etc"))
        self.assertTrue(glob_match("/etc/**", "/etc/passwd"))

    def test_single_star_stays_in_segment(self):
        self.assertTrue(glob_match("/var/log/*.log", "/var/log/app.log"))
        self.assertFalse(glob_match("/var/log/*.log", "/var/log/sub/app.log"))

    def test_question_mark_one_char(self):
        self.assertTrue(glob_match("/a/file?.txt", "/a/file1.txt"))
        self.assertFalse(glob_match("/a/file?.txt", "/a/file12.txt"))
        self.assertFalse(glob_match("/a/file?.txt", "/a/file/.txt"))

    def test_literal_no_match(self):
        self.assertFalse(glob_match("/etc/passwd", "/etc/passwdX"))
        self.assertTrue(glob_match("/etc/passwd", "/etc/passwd"))

    def test_empty_inputs(self):
        self.assertFalse(glob_match("", "/x"))
        self.assertFalse(glob_match("/x", ""))

    def test_middle_double_star(self):
        self.assertTrue(glob_match("/home/**/secret", "/home/a/b/secret"))
        self.assertTrue(glob_match("/home/**/secret", "/home/secret"))


# ---------------------------------------------------------------------------
# 대소문자 무시 FS — CRITICAL
# ---------------------------------------------------------------------------

class TestCaseInsensitiveMatching(unittest.TestCase):
    """macOS/Windows 대소문자 무시 FS에서 deny 우회 방어."""

    def _match_ci(self, pattern: str, path: str) -> bool:
        """IGNORECASE 강제 적용으로 플랫폼 무관 테스트."""
        return _compile_glob(pattern, case_insensitive=True).match(path) is not None

    def test_uppercase_path_matches_lowercase_deny(self):
        # deny '/Users/me/.ssh/**' 가 '/Users/me/.SSH/id_rsa' 를 잡아야 한다.
        self.assertTrue(self._match_ci("/Users/me/.ssh/**", "/Users/me/.SSH/id_rsa"))
        self.assertTrue(self._match_ci("/Users/me/.ssh/**", "/USERS/ME/.SSH/id_rsa"))

    def test_mixed_case_single_star(self):
        self.assertTrue(self._match_ci("/etc/*.conf", "/etc/System.Conf"))

    def test_literal_case_insensitive(self):
        self.assertTrue(self._match_ci("/etc/Passwd", "/etc/passwd"))
        self.assertTrue(self._match_ci("/etc/passwd", "/etc/PASSWD"))

    def test_case_sensitive_when_flag_off(self):
        self.assertFalse(
            _compile_glob("/Users/me/.ssh/**", case_insensitive=False).match(
                "/Users/me/.SSH/id_rsa"
            )
        )

    def test_glob_match_uses_platform_flag(self):
        """glob_match()가 _CASE_INSENSITIVE_FS를 존중한다."""
        import syncspace_monitor.rules as r_mod
        original = r_mod._CASE_INSENSITIVE_FS
        try:
            r_mod._CASE_INSENSITIVE_FS = True
            self.assertTrue(glob_match("/tmp/secret/**", "/TMP/SECRET/x"))
        finally:
            r_mod._CASE_INSENSITIVE_FS = original

    def test_evaluate_ci_deny(self):
        """evaluate()가 CI 모드에서 대소문자 변형 경로를 차단한다."""
        import syncspace_monitor.rules as r_mod
        original = r_mod._CASE_INSENSITIVE_FS
        try:
            r_mod._CASE_INSENSITIVE_FS = True
            rs = [Rule(id="ci1", kind="deny", glob="/Users/me/.ssh/**")]
            d = evaluate(rs, "/Users/me/.SSH/id_rsa")
            self.assertFalse(d.allowed)
            self.assertEqual(d.rule_id, "ci1")
        finally:
            r_mod._CASE_INSENSITIVE_FS = original


# ---------------------------------------------------------------------------
# NFC/NFD 유니코드 방어
# ---------------------------------------------------------------------------

class TestUnicodeNFC(unittest.TestCase):
    """NFC로 작성한 deny 규칙이 NFD 경로를 차단해야 한다."""

    def test_nfc_nfd_normalization_equalizes(self):
        import unicodedata
        # café: NFC(U+00E9 단일 코드포인트), NFD(e + U+0301 결합)
        nfc = unicodedata.normalize("NFC", "café")
        nfd = unicodedata.normalize("NFD", "café")
        # 원본은 다른 바이트여야 한다.
        self.assertNotEqual(nfc, nfd)
        # _nfc 적용 후는 동일해야 한다.
        self.assertEqual(_nfc(nfc), _nfc(nfd))

    def test_deny_nfc_blocks_nfd_path(self):
        """NFC glob 패턴이 NFD 경로를 차단한다."""
        import unicodedata
        nfc_dir = unicodedata.normalize("NFC", "/proj/café/**")
        nfd_path = unicodedata.normalize("NFD", "/proj/café/secret.txt")
        self.assertTrue(glob_match(nfc_dir, nfd_path))

    def test_nfd_glob_blocks_nfc_path(self):
        """NFD glob 패턴도 NFC 경로를 차단한다(양방향)."""
        import unicodedata
        nfd_dir = unicodedata.normalize("NFD", "/proj/café/**")
        nfc_path = unicodedata.normalize("NFC", "/proj/café/secret.txt")
        self.assertTrue(glob_match(nfd_dir, nfc_path))

    def test_normalize_path_returns_nfc(self):
        """normalize_path 결과가 NFC 형태여야 한다."""
        import unicodedata
        nfd_path = unicodedata.normalize("NFD", "/tmp/café/file.txt")
        result = rules.normalize_path(nfd_path)
        if result:
            self.assertEqual(result, unicodedata.normalize("NFC", result))


# ---------------------------------------------------------------------------
# 경로 정규화
# ---------------------------------------------------------------------------

class TestNormalizePath(unittest.TestCase):
    def test_tilde_expansion(self):
        norm = rules.normalize_path("~/foo")
        self.assertIsNotNone(norm)
        self.assertTrue(norm.startswith(os.path.expanduser("~").replace(os.sep, "/")))

    def test_relative_resolved_against_cwd(self):
        norm = rules.normalize_path("sub/file.txt", cwd="/tmp/work")
        self.assertTrue(norm.startswith("/"))
        self.assertTrue(norm.endswith("/sub/file.txt"))

    def test_dotdot_collapsed(self):
        norm = rules.normalize_path("/a/b/../c")
        self.assertTrue(norm.endswith("/a/c"))

    def test_invalid_returns_none(self):
        self.assertIsNone(rules.normalize_path(""))
        self.assertIsNone(rules.normalize_path(None))  # type: ignore


# ---------------------------------------------------------------------------
# evaluate
# ---------------------------------------------------------------------------

class TestEvaluate(unittest.TestCase):
    def test_default_policy_allow(self):
        d = evaluate([], "/any/path")
        self.assertTrue(d.allowed)
        self.assertIsNone(d.rule_id)
        self.assertIsNone(d.matched_kind)

    def test_deny_blocks(self):
        rs = [Rule(id="r1", kind="deny", glob="/Users/me/.ssh/**")]
        d = evaluate(rs, "/Users/me/.ssh/id_rsa")
        self.assertFalse(d.allowed)
        self.assertEqual(d.rule_id, "r1")
        self.assertEqual(d.matched_kind, "deny")

    def test_deny_overrides_allow(self):
        rs = [
            Rule(id="a1", kind="allow", glob="/proj/**"),
            Rule(id="d1", kind="deny", glob="/proj/secrets/**"),
        ]
        d = evaluate(rs, "/proj/secrets/key.pem")
        self.assertFalse(d.allowed)
        self.assertEqual(d.rule_id, "d1")

    def test_deny_overrides_regardless_of_order(self):
        rs = [
            Rule(id="d1", kind="deny", glob="/proj/secrets/**"),
            Rule(id="a1", kind="allow", glob="/proj/**"),
        ]
        d = evaluate(rs, "/proj/secrets/key.pem")
        self.assertFalse(d.allowed)
        self.assertEqual(d.rule_id, "d1")

    def test_allow_match_reported(self):
        rs = [Rule(id="a1", kind="allow", glob="/proj/**")]
        d = evaluate(rs, "/proj/src/main.py")
        self.assertTrue(d.allowed)
        self.assertEqual(d.rule_id, "a1")
        self.assertEqual(d.matched_kind, "allow")

    def test_disabled_rule_skipped(self):
        rs = [Rule(id="d1", kind="deny", glob="/x/**", enabled=False)]
        d = evaluate(rs, "/x/y")
        self.assertTrue(d.allowed)


class TestScope(unittest.TestCase):
    def test_global_applies_everywhere(self):
        r = Rule(id="g", kind="deny", glob="/x", scope="global")
        self.assertTrue(r.applies_to(None, None))
        self.assertTrue(r.applies_to("s1", "a1"))

    def test_session_scope(self):
        r = Rule(id="s", kind="deny", glob="/x", scope="session:abc")
        self.assertTrue(r.applies_to("abc", None))
        self.assertFalse(r.applies_to("other", None))
        self.assertFalse(r.applies_to(None, None))

    def test_agent_scope(self):
        r = Rule(id="ag", kind="deny", glob="/x", scope="agent:hermes:xy")
        self.assertTrue(r.applies_to(None, "hermes:xy"))
        self.assertFalse(r.applies_to(None, "hermes:zz"))

    def test_session_scoped_deny_only_in_session(self):
        rs = [Rule(id="d1", kind="deny", glob="/x/**", scope="session:S1")]
        self.assertFalse(evaluate(rs, "/x/y", session_id="S1").allowed)
        self.assertTrue(evaluate(rs, "/x/y", session_id="S2").allowed)


# ---------------------------------------------------------------------------
# RuleStore
# ---------------------------------------------------------------------------

class TestRuleStore(unittest.TestCase):
    def _write_rules(self, path, rules_list):
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"rules": rules_list}, fh)

    def test_empty_file_path_allows_all(self):
        store = RuleStore("")
        self.assertEqual(store.get_rules(), [])
        self.assertTrue(store.evaluate("/anything").allowed)

    def test_loads_and_evaluates(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "rules.json")
            self._write_rules(p, [{"id": "d1", "kind": "deny", "glob": "/secret/**"}])
            store = RuleStore(p)
            self.assertFalse(store.evaluate("/secret/x").allowed)
            self.assertTrue(store.evaluate("/ok/x").allowed)

    def test_malformed_rules_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "rules.json")
            self._write_rules(
                p,
                [
                    {"id": "good", "kind": "deny", "glob": "/x/**"},
                    {"kind": "deny", "glob": "/y/**"},   # no id
                    {"id": "bad", "kind": "nope", "glob": "/z/**"},  # bad kind
                    "not a dict",
                ],
            )
            store = RuleStore(p)
            self.assertEqual(len(store.get_rules()), 1)

    def test_mtime_reload(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "rules.json")
            self._write_rules(p, [])
            store = RuleStore(p)
            self.assertTrue(store.evaluate("/secret/x").allowed)
            self._write_rules(p, [{"id": "d1", "kind": "deny", "glob": "/secret/**"}])
            os.utime(p, (os.path.getmtime(p) + 10, os.path.getmtime(p) + 10))
            self.assertFalse(store.evaluate("/secret/x").allowed)

    def test_missing_file_graceful(self):
        store = RuleStore("/nonexistent/path/rules.json")
        self.assertTrue(store.evaluate("/x").allowed)

    def test_reload_race_no_exception(self):
        """멀티스레드 동시 reload가 예외를 던지지 않는다(mtime 레이스 방어)."""
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "rules.json")
            self._write_rules(p, [{"id": "d1", "kind": "deny", "glob": "/x/**"}])
            store = RuleStore(p)
            errors = []

            def _reload():
                try:
                    for _ in range(50):
                        store._reload_if_changed()
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=_reload) for _ in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(errors, [], f"thread errors: {errors}")

    def test_parse_failure_rolls_back_mtime(self):
        """파싱 실패 시 mtime 롤백 → 다음 호출에서 재시도 가능, 기존 규칙 유지."""
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "rules.json")
            self._write_rules(p, [{"id": "d1", "kind": "deny", "glob": "/x/**"}])
            store = RuleStore(p)
            self.assertFalse(store.evaluate("/x/y").allowed)

            # 손상된 JSON + mtime 갱신.
            with open(p, "w") as fh:
                fh.write("{invalid json")
            new_mtime = os.path.getmtime(p) + 5
            os.utime(p, (new_mtime, new_mtime))
            prev_mtime = store._mtime

            store._reload_if_changed()
            # 파싱 실패 → mtime 롤백.
            self.assertEqual(store._mtime, prev_mtime)
            # 기존 규칙은 살아있어야 한다.
            self.assertFalse(store.evaluate("/x/y").allowed)


if __name__ == "__main__":
    unittest.main()
