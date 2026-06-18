"""G0 검증기 단위 테스트 — g0_validate._check() 계약 검사.

실행:
    python3 -m unittest discover -s tests -v
    python3 -m unittest tests.test_g0_validate -v
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

# scripts/g0_validate.py 를 패키지 외부에서 직접 임포트한다.
_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
_spec = importlib.util.spec_from_file_location(
    "g0_validate", _SCRIPTS_DIR / "g0_validate.py"
)
_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

_check = _mod._check
_validate = _mod.validate


# ---------------------------------------------------------------------------
# 헬퍼
# ---------------------------------------------------------------------------

def _write_payload(data: dict) -> Path:
    """임시 파일에 페이로드 JSON 을 쓰고 Path 를 반환한다."""
    tf = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    )
    json.dump(data, tf)
    tf.close()
    return Path(tf.name)


# ---------------------------------------------------------------------------
# _check() 직접 테스트 (파일 I/O 없음)
# ---------------------------------------------------------------------------

class TestCheckComplete(unittest.TestCase):
    """완전한 페이로드는 FAIL 없이 통과해야 한다."""

    def setUp(self) -> None:
        self.payload = {
            "tool_name": "write_file",
            "args": {
                "path": "/tmp/test_file.txt",
                "content": "hello",
            },
            "session_id": "sess-abc123",
            "task_id": "task-xyz",
            "turn_id": "turn-001",
            "tool_call_id": "tcid-deadbeef",
            "cwd": "/home/user/project",
            "git_branch": "main",
        }

    def test_no_failures(self) -> None:
        """완전한 페이로드는 failures 가 비어야 한다."""
        failures, _ = _check(self.payload)
        self.assertEqual(failures, [], f"예상치 못한 failures: {failures}")

    def test_no_warnings(self) -> None:
        """완전한 페이로드는 warnings 도 비어야 한다."""
        _, warnings = _check(self.payload)
        self.assertEqual(warnings, [], f"예상치 못한 warnings: {warnings}")


class TestCheckMissingToolName(unittest.TestCase):
    """tool_name 누락 시 FAIL 이어야 한다."""

    def setUp(self) -> None:
        self.payload = {
            # tool_name 없음
            "args": {"path": "/tmp/foo.txt"},
            "session_id": "sess-abc",
            "task_id": "task-1",
            "turn_id": "turn-1",
            "tool_call_id": "tcid-1",
            "cwd": "/tmp",
            "git_branch": "main",
        }

    def test_has_failure(self) -> None:
        """tool_name 없으면 failures 가 비어있지 않아야 한다."""
        failures, _ = _check(self.payload)
        self.assertTrue(
            len(failures) > 0,
            "tool_name 누락 시 failures 가 있어야 한다.",
        )

    def test_failure_mentions_tool_name(self) -> None:
        """failure 메시지에 'tool_name' 이 언급되어야 한다."""
        failures, _ = _check(self.payload)
        self.assertTrue(
            any("tool_name" in f for f in failures),
            f"failures 에 tool_name 언급 없음: {failures}",
        )


class TestCheckMissingArgs(unittest.TestCase):
    """args 누락 시 FAIL 이어야 한다."""

    def setUp(self) -> None:
        self.payload = {
            "tool_name": "read_file",
            # args 없음
            "session_id": "sess-abc",
            "task_id": "task-1",
            "turn_id": "turn-1",
            "tool_call_id": "tcid-1",
            "cwd": "/tmp",
            "git_branch": "main",
        }

    def test_has_failure(self) -> None:
        """args 없으면 failures 가 비어있지 않아야 한다."""
        failures, _ = _check(self.payload)
        self.assertTrue(
            len(failures) > 0,
            "args 누락 시 failures 가 있어야 한다.",
        )

    def test_failure_mentions_args(self) -> None:
        """failure 메시지에 'args' 가 언급되어야 한다."""
        failures, _ = _check(self.payload)
        self.assertTrue(
            any("args" in f for f in failures),
            f"failures 에 args 언급 없음: {failures}",
        )


class TestCheckToolNameArgsOnlyNoContext(unittest.TestCase):
    """tool_name + args 만 있고 선택 컨텍스트 키 없음 → PASS-with-warnings."""

    def setUp(self) -> None:
        self.payload = {
            "tool_name": "terminal",
            "args": {"command": "echo hello"},
            # 선택 컨텍스트 키 전부 없음
        }

    def test_no_failures(self) -> None:
        """필수 필드만 있어도 failures 는 없어야 한다."""
        failures, _ = _check(self.payload)
        self.assertEqual(failures, [], f"예상치 못한 failures: {failures}")

    def test_has_warnings(self) -> None:
        """선택 컨텍스트 키 없으면 warnings 가 있어야 한다."""
        _, warnings = _check(self.payload)
        self.assertTrue(
            len(warnings) > 0,
            "선택 컨텍스트 키 부재 시 warnings 가 있어야 한다.",
        )

    def test_warnings_mention_context_keys(self) -> None:
        """warnings 에 선택 컨텍스트 키 이름들이 포함되어야 한다."""
        _, warnings = _check(self.payload)
        context_keys = {"session_id", "task_id", "turn_id", "tool_call_id", "cwd", "git_branch"}
        warned_keys = {
            key for key in context_keys
            if any(key in w for w in warnings)
        }
        self.assertEqual(
            warned_keys,
            context_keys,
            f"warnings 에 포함되지 않은 컨텍스트 키: {context_keys - warned_keys}",
        )


# ---------------------------------------------------------------------------
# validate() 통합 테스트 (파일 I/O 포함)
# ---------------------------------------------------------------------------

class TestValidateReturnCodes(unittest.TestCase):
    """validate() 함수가 올바른 종료 코드를 반환해야 한다."""

    def test_complete_payload_returns_0(self) -> None:
        """완전한 페이로드는 종료 코드 0."""
        payload = {
            "tool_name": "write_file",
            "args": {"path": "/tmp/g0.txt", "content": "x"},
            "session_id": "sess-1",
            "task_id": "task-1",
            "turn_id": "turn-1",
            "tool_call_id": "tcid-1",
            "cwd": "/tmp",
            "git_branch": "main",
        }
        p = _write_payload(payload)
        try:
            self.assertEqual(_validate(p), 0)
        finally:
            p.unlink(missing_ok=True)

    def test_missing_tool_name_returns_1(self) -> None:
        """tool_name 없으면 종료 코드 1."""
        payload = {"args": {"path": "/tmp/g0.txt"}}
        p = _write_payload(payload)
        try:
            self.assertEqual(_validate(p), 1)
        finally:
            p.unlink(missing_ok=True)

    def test_missing_args_returns_1(self) -> None:
        """args 없으면 종료 코드 1."""
        payload = {"tool_name": "read_file"}
        p = _write_payload(payload)
        try:
            self.assertEqual(_validate(p), 1)
        finally:
            p.unlink(missing_ok=True)

    def test_tool_name_args_only_returns_0(self) -> None:
        """tool_name + args 만 있어도 종료 코드 0 (경고는 있어도 pass)."""
        payload = {
            "tool_name": "terminal",
            "args": {"command": "ls /tmp"},
        }
        p = _write_payload(payload)
        try:
            self.assertEqual(_validate(p), 0)
        finally:
            p.unlink(missing_ok=True)

    def test_nonexistent_file_returns_2(self) -> None:
        """존재하지 않는 파일은 종료 코드 2."""
        self.assertEqual(_validate(Path("/nonexistent/path/payload.json")), 2)

    def test_invalid_json_returns_2(self) -> None:
        """유효하지 않은 JSON 은 종료 코드 2."""
        tf = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        )
        tf.write("not valid json {{{")
        tf.close()
        p = Path(tf.name)
        try:
            self.assertEqual(_validate(p), 2)
        finally:
            p.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# 1급 파일 툴 args.path 경고 테스트
# ---------------------------------------------------------------------------

class TestFirstClassFileToolPathWarning(unittest.TestCase):
    """1급 파일 툴에서 args.path 없으면 WARN 이어야 한다."""

    def test_write_file_without_path_warns(self) -> None:
        payload = {
            "tool_name": "write_file",
            "args": {"content": "hello"},  # path 없음
        }
        failures, warnings = _check(payload)
        self.assertEqual(failures, [])
        self.assertTrue(
            any("args.path" in w for w in warnings),
            f"args.path 경고 없음: {warnings}",
        )

    def test_terminal_without_path_no_warn(self) -> None:
        """terminal 은 1급 파일 툴이 아니므로 args.path 경고 없어야 한다."""
        payload = {
            "tool_name": "terminal",
            "args": {"command": "echo hi"},
        }
        failures, warnings = _check(payload)
        self.assertEqual(failures, [])
        self.assertFalse(
            any("args.path" in w for w in warnings),
            f"terminal 에서 불필요한 args.path 경고 발생: {warnings}",
        )


if __name__ == "__main__":
    unittest.main()
