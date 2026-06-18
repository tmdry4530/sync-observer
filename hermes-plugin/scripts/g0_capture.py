"""G0 캡처 도구 — LIVE 모드와 SIMULATE 모드 두 가지로 동작한다.

LIVE 모드 (--live):
    hermes CLI가 PATH에 있을 때만 동작한다.
    `hermes hooks test pre_tool_call` 명령을 실행해 실제 런타임 동일형태
    페이로드를 캡처한 뒤 g0_captured_payload.json 에 저장한다.
    hermes 가 없으면 명확한 에러 메시지와 실행할 정확한 명령을 출력하고 종료.

SIMULATE 모드 (기본값, --simulate 또는 hermes 없을 때):
    실제 hermes pre_tool_call 페이로드 형태를 재현한 대표 샘플을 생성한다.
    HERMES_OPERATION ⑧ 에 기록된 wire shape 기준:
        {hook_event_name, tool_name, tool_input(=args), session_id, cwd, extra}
    Python 플러그인이 수신하는 kwargs 키도 함께 포함한다:
        task_id, turn_id, tool_call_id, git_branch

사용:
    python3 scripts/g0_capture.py            # SIMULATE (항상 가능)
    python3 scripts/g0_capture.py --simulate # 명시 SIMULATE
    python3 scripts/g0_capture.py --live     # LIVE (hermes 필수)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# 캡처 결과를 저장할 파일 (scripts/ 디렉토리 기준 고정).
_SCRIPT_DIR = Path(__file__).parent.resolve()
OUTPUT_FILE = _SCRIPT_DIR / "g0_captured_payload.json"

# hermes CLI 명령 (PATH에서 탐색).
_HERMES_CMD = "hermes"

# LIVE 모드에서 실행할 정확한 hermes 명령.
_HERMES_TEST_CMD = ["hermes", "hooks", "test", "pre_tool_call", "--for-tool", "write_file"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _hermes_on_path() -> bool:
    """hermes CLI 가 PATH 에 존재하는지 확인한다."""
    return shutil.which(_HERMES_CMD) is not None


def run_live() -> None:
    """LIVE 모드: hermes hooks test pre_tool_call 실행 후 stdout을 파싱해 저장한다.

    hermes 가 없으면 FAIL CLEARLY — 크래시 없이 명확한 에러 + 실행 명령 안내.
    """
    if not _hermes_on_path():
        print(
            "[G0 LIVE] ERROR: `hermes` 가 PATH 에 없습니다.\n"
            "\n"
            "hermes 를 설치하거나 PATH 에 추가한 뒤 아래 명령을 실행하세요:\n"
            "\n"
            "    hermes hooks test pre_tool_call --for-tool write_file\n"
            "\n"
            "캡처 스크립트 재실행:\n"
            "\n"
            "    python3 scripts/g0_capture.py --live\n"
            "\n"
            "hermes 없이 시뮬레이션 페이로드를 생성하려면:\n"
            "\n"
            "    python3 scripts/g0_capture.py --simulate\n",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"[G0 LIVE] 실행: {' '.join(_HERMES_TEST_CMD)}")
    env = os.environ.copy()
    env["HERMES_ACCEPT_HOOKS"] = "1"

    try:
        result = subprocess.run(
            _HERMES_TEST_CMD,
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        print("[G0 LIVE] ERROR: hermes hooks test 타임아웃 (30s)", file=sys.stderr)
        sys.exit(1)

    if result.returncode != 0:
        print(
            f"[G0 LIVE] ERROR: hermes 가 비정상 종료 (코드 {result.returncode}).\n"
            f"stderr:\n{result.stderr}",
            file=sys.stderr,
        )
        sys.exit(1)

    # stdout 에서 JSON 페이로드 추출 시도.
    stdout = result.stdout.strip()
    payload: dict | None = None

    # hermes 는 JSON 을 stdout 에 직접 출력하거나 {payload: ...} 래퍼로 출력할 수 있다.
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
                break
            except json.JSONDecodeError:
                continue

    if payload is None:
        # stdout 전체가 JSON 이면 그대로 파싱.
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError:
            print(
                "[G0 LIVE] ERROR: hermes 출력에서 JSON 페이로드를 찾지 못했습니다.\n"
                f"stdout:\n{stdout}",
                file=sys.stderr,
            )
            sys.exit(1)

    # G0 메타데이터를 주석 필드로 첨부.
    payload["_g0_meta"] = {
        "mode": "live",
        "captured_at": _now_iso(),
        "hermes_cmd": " ".join(_HERMES_TEST_CMD),
    }

    _write_output(payload, mode="live")


def run_simulate() -> None:
    """SIMULATE 모드: 대표 페이로드 샘플을 생성한다.

    HERMES_OPERATION ⑧ 기준 wire shape:
        {hook_event_name, tool_name, tool_input, session_id, cwd, extra}
    Python 플러그인 kwargs 에 매핑되는 키도 포함:
        task_id, turn_id, tool_call_id, git_branch (extra 안에 위치 가능)

    플러그인이 on_pre_tool_call 에서 실제로 읽는 키 목록 (hooks.py 실측):
        - tool_name  (필수)
        - args       (필수, tool_input 이 Python hook 에서 args 로 바인딩됨)
        - session_id (선택 context)
        - task_id    (선택 context)
        - turn_id    (선택 context)
        - tool_call_id (선택 context, correlationId 로 매핑)
        - cwd        (선택 context)
        - git_branch (선택 context)
    """
    session_id = f"sess-{uuid.uuid4().hex[:16]}"
    task_id = f"task-{uuid.uuid4().hex[:12]}"
    turn_id = f"turn-{uuid.uuid4().hex[:8]}"
    tool_call_id = f"tcid-{uuid.uuid4().hex[:12]}"

    # write_file 페이로드 (1급 파일 툴 대표 샘플 — args.path 필수).
    payload = {
        # ── wire-level 키 (hermes 가 shell hook 에 전달하는 stdin JSON) ──
        "hook_event_name": "pre_tool_call",
        "tool_name": "write_file",
        "tool_input": {
            "path": "/tmp/syncspace_g0_test_file.txt",
            "content": "G0 seal test — simulated write_file payload",
        },
        "session_id": session_id,
        "cwd": str(Path.home() / "hermes-workspace"),
        # ── extra 블록: Python 플러그인이 **kwargs 로 수신하는 추가 컨텍스트 ──
        "extra": {
            "task_id": task_id,
            "turn_id": turn_id,
            "tool_call_id": tool_call_id,
            "git_branch": "main",
        },
        # ── Python 플러그인 직접 kwargs (invoke_hook 이 flat 으로 전달) ──
        # hermes 가 Python 플러그인을 호출할 때는 아래 키들이 **kwargs 로 직접 도달.
        # shell hook 의 stdin JSON 과 Python hook 의 kwargs 는 동일한 invoke_hook
        # 경로를 통과하므로 두 표현을 모두 포함한다.
        "args": {
            "path": "/tmp/syncspace_g0_test_file.txt",
            "content": "G0 seal test — simulated write_file payload",
        },
        "task_id": task_id,
        "turn_id": turn_id,
        "tool_call_id": tool_call_id,
        "git_branch": "main",
        # ── G0 메타 ──
        "_g0_meta": {
            "mode": "simulate",
            "captured_at": _now_iso(),
            "note": (
                "HERMES_OPERATION ⑧ 기준 대표 샘플. "
                "실물 봉인은 hermes 설치 후 --live 플래그로 재실행하세요."
            ),
        },
    }

    _write_output(payload, mode="simulate")


def _write_output(payload: dict, *, mode: str) -> None:
    OUTPUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"[G0 {mode.upper()}] 페이로드 저장 완료: {OUTPUT_FILE}")
    print(f"[G0 {mode.upper()}] 검증 실행: python3 {_SCRIPT_DIR}/g0_validate.py {OUTPUT_FILE}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="G0 캡처 도구 — hermes pre_tool_call 페이로드 캡처/시뮬레이션"
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--live",
        action="store_true",
        help="LIVE 모드: hermes hooks test pre_tool_call 실행 (hermes 필수)",
    )
    group.add_argument(
        "--simulate",
        action="store_true",
        help="SIMULATE 모드: 대표 페이로드 샘플 생성 (hermes 불필요, 기본값)",
    )
    args = parser.parse_args()

    if args.live:
        run_live()
    else:
        # --simulate 명시 또는 인자 없음 → SIMULATE
        run_simulate()


if __name__ == "__main__":
    main()
