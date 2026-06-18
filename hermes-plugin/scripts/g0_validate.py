"""G0 검증기 — 캡처된 페이로드 JSON이 플러그인 hook 계약을 만족하는지 검사한다.

필수 필드 (FAIL):
    tool_name  — on_pre_tool_call 의 첫 번째 positional/keyword 인자
    args       — on_pre_tool_call 의 두 번째 인자 (dict 여야 extract_raw_paths 가 동작)

선택 컨텍스트 필드 (WARN if absent):
    session_id   — agentId 도출 + 규칙 scope 매칭
    task_id      — 이벤트 taskId 필드
    turn_id      — 이벤트 turnId 필드
    tool_call_id — 이벤트 correlationId 필드
    cwd          — normalize_path 의 base 경로
    git_branch   — 이벤트 gitBranch 필드

1급 파일 툴(read_file, write_file, patch, search_files) 이면 args.path 존재도 확인한다.
    존재하지 않으면 WARN (pathParseMiss 동작이 예상되므로 FAIL 은 아니다).

사용:
    python3 scripts/g0_validate.py scripts/g0_captured_payload.json
    python3 scripts/g0_validate.py <payload.json>  # 임의 경로 가능

종료 코드:
    0 — 필수 필드 모두 통과 (경고 있어도 0)
    1 — 필수 필드 하나 이상 누락
    2 — 파일을 읽거나 파싱할 수 없음
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# 플러그인이 실제로 읽는 필드 (hooks.py + events.py 실측 기준).
# REQUIRED: 누락 시 FAIL + 비정상 종료.
REQUIRED_FIELDS: list[str] = ["tool_name", "args"]

# OPTIONAL: 누락 시 WARN 만 출력, 종료 코드에 영향 없음.
OPTIONAL_CONTEXT_FIELDS: list[str] = [
    "session_id",
    "task_id",
    "turn_id",
    "tool_call_id",
    "cwd",
    "git_branch",
]

# 1급 파일 툴 — args.path 가 있어야 extract_raw_paths 가 경로를 뽑는다.
FIRST_CLASS_FILE_TOOLS = {"read_file", "write_file", "patch", "search_files"}


def _check(payload: dict) -> tuple[list[str], list[str]]:
    """페이로드를 검사하고 (failures, warnings) 를 반환한다."""
    failures: list[str] = []
    warnings: list[str] = []

    # ── 필수 필드 ──────────────────────────────────────────────────────────
    for field in REQUIRED_FIELDS:
        if field not in payload:
            failures.append(f"FAIL  [{field}] 필드 없음 (필수)")
        elif field == "tool_name":
            val = payload[field]
            if not isinstance(val, str) or not val.strip():
                failures.append(
                    f"FAIL  [{field}] 값이 비어있거나 str 이 아님: {val!r}"
                )
            else:
                print(f"PASS  [tool_name] = {val!r}")
        elif field == "args":
            val = payload[field]
            if not isinstance(val, dict):
                failures.append(
                    f"FAIL  [args] dict 가 아님 (type={type(val).__name__}). "
                    "extract_raw_paths 가 경로 추출 불가."
                )
            else:
                print(f"PASS  [args] dict({list(val.keys())})")

    # ── args.path 존재 여부 (1급 파일 툴 한정) ──────────────────────────
    tool_name = payload.get("tool_name", "")
    if tool_name in FIRST_CLASS_FILE_TOOLS:
        args = payload.get("args")
        if isinstance(args, dict):
            if "path" not in args:
                warnings.append(
                    f"WARN  [args.path] 1급 파일 툴 '{tool_name}' 이지만 "
                    "args.path 없음 → pathParseMiss 동작 예상"
                )
            else:
                path_val = args["path"]
                if isinstance(path_val, str) and path_val:
                    print(f"PASS  [args.path] = {path_val!r}")
                else:
                    warnings.append(
                        f"WARN  [args.path] 값이 비어있거나 str 이 아님: {path_val!r}"
                    )

    # ── 선택 컨텍스트 필드 ────────────────────────────────────────────────
    for field in OPTIONAL_CONTEXT_FIELDS:
        if field not in payload:
            warnings.append(f"WARN  [{field}] 없음 (선택, 이벤트 품질 저하 가능)")
        else:
            print(f"PASS  [{field}] = {payload[field]!r}")

    return failures, warnings


def validate(path: Path) -> int:
    """페이로드 파일을 검증하고 종료 코드를 반환한다."""
    # ── 파일 로드 ──────────────────────────────────────────────────────────
    if not path.exists():
        print(f"[G0 VALIDATE] ERROR: 파일을 찾을 수 없습니다: {path}", file=sys.stderr)
        return 2

    try:
        raw = path.read_text(encoding="utf-8")
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(
            f"[G0 VALIDATE] ERROR: JSON 파싱 실패: {exc}", file=sys.stderr
        )
        return 2
    except OSError as exc:
        print(f"[G0 VALIDATE] ERROR: 파일 읽기 실패: {exc}", file=sys.stderr)
        return 2

    if not isinstance(payload, dict):
        print(
            f"[G0 VALIDATE] ERROR: 최상위 JSON 이 object 가 아님 (type={type(payload).__name__})",
            file=sys.stderr,
        )
        return 2

    # ── G0 메타 출력 ──────────────────────────────────────────────────────
    meta = payload.get("_g0_meta", {})
    mode = meta.get("mode", "unknown")
    captured_at = meta.get("captured_at", "N/A")
    print(f"\n[G0 VALIDATE] 파일: {path}")
    print(f"[G0 VALIDATE] 모드: {mode}  |  캡처 시각: {captured_at}")
    print("-" * 60)

    # ── 검사 실행 ──────────────────────────────────────────────────────────
    failures, warnings = _check(payload)

    # ── 결과 요약 ──────────────────────────────────────────────────────────
    print("-" * 60)
    if warnings:
        for w in warnings:
            print(w)

    print()
    if failures:
        for f in failures:
            print(f)
        print(
            f"\n[G0 VALIDATE] FAIL — 필수 필드 {len(failures)}개 누락. "
            "G0 봉인 불가.\n"
        )
        return 1

    if warnings:
        print(
            f"[G0 VALIDATE] PASS (경고 {len(warnings)}개) — 필수 필드 모두 존재. "
            "선택 컨텍스트 필드 일부 없음 (이벤트 품질 저하 가능).\n"
        )
    else:
        print(
            "[G0 VALIDATE] PASS — 모든 필수 + 선택 필드 존재. "
            "G0 봉인 준비 완료.\n"
        )

    return 0


def main() -> None:
    if len(sys.argv) < 2:
        # 인자 없으면 scripts/ 옆 기본 파일 시도.
        default = Path(__file__).parent / "g0_captured_payload.json"
        print(
            f"[G0 VALIDATE] 페이로드 파일 경로 미지정. 기본값 사용: {default}\n"
            "사용법: python3 scripts/g0_validate.py <payload.json>"
        )
        payload_path = default
    else:
        payload_path = Path(sys.argv[1])

    sys.exit(validate(payload_path))


if __name__ == "__main__":
    main()
