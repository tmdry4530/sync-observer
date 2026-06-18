"""정규화 이벤트 빌더 — hook kwargs를 PIVOT §3 스키마로 변환 (stdlib only).

핵심 책임:
  - action 매핑 (read_file→read, write_file→write, patch→edit, ...)
  - paths 추출 (파일 툴은 args.path, terminal은 best-effort 파서)
  - terminal command 파서 (셸 평가 절대 금지, 화이트리스트 토큰만)
  - agentId 도출 (`hermes:<disambiguator>`)
모든 함수는 예외 안전(실패 시 안전 폴백).

hermes PATCH_SCHEMA 실측 결과 (tools/file_tools.py:1545-1594, 로컬 클론):
  - mode='replace': 단일 `path` 키 (required when mode='replace').
  - mode='patch': V4A 텍스트 `patch` 키 — 파일 경로가 텍스트 내부에 내장됨.
    `files[]`, `output_path`, `workdir` 등의 별도 path 키는 없음.
    → mode='patch' 호출은 args.path가 없어 경로 추출 결과가 [] → pathParseMiss.
  read_file / write_file / search_files 에도 추가 path 키 없음(실측 확인).
"""

from __future__ import annotations

import logging
import os
import shlex
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

# 원시 tool_name -> 정규화 action.
# search_files는 file_glob/glob 모드 판정이 필요하므로 별도 처리(아래 _map_action).
_ACTION_MAP = {
    "read_file": "read",
    "write_file": "write",
    "patch": "edit",
    "terminal": "bash",
    "delegate_task": "task",
}

# 1급 파일 툴 (pre-block 대상이 되는 안정 named-key 툴).
FIRST_CLASS_FILE_TOOLS = {"read_file", "write_file", "patch", "search_files"}

# 정적으로 전개 가능한 환경변수 화이트리스트 (셸 평가 없이 os.environ 사용).
_EXPANDABLE_VARS = {"HOME", "PWD", "TMPDIR", "TMP", "TEMP", "USERPROFILE"}


def now_iso_ms() -> str:
    """ISO-8601 ms 정밀도 UTC 타임스탬프 (소스 발생 시각)."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _map_action(tool_name: str, args: Any) -> str:
    """원시 tool_name(+args)을 정규화 action 동사로 매핑한다."""
    if tool_name == "search_files":
        # target='files' 또는 file_glob 지정 시 glob, 아니면 grep.
        if isinstance(args, dict):
            target = args.get("target")
            if target == "files":
                return "glob"
            if args.get("file_glob"):
                return "glob"
        return "grep"
    return _ACTION_MAP.get(tool_name, "other")


# ---------------------------------------------------------------------------
# terminal 파서
# ---------------------------------------------------------------------------

# 경로처럼 보이는 토큰 판정 시 제거할 셸 메타문자.
# ※ glob 메타(*?[]) 는 _expand_token에서 별도 처리 — 여기서 걸러내지 않음.
_SHELL_META_STRICT = set("|&;<>(){}$`!\"'\\")


def _expand_static_vars(token: str) -> str:
    """$VAR / ${VAR} 형태의 화이트리스트 변수만 정적 전개 (셸 평가 금지).

    화이트리스트 외 변수($UNKNOWN 등)는 그대로 두어 후속 처리에서 걸러진다.
    """
    import re
    def _repl(m: "re.Match[str]") -> str:
        name = m.group(1) or m.group(2)
        if name in _EXPANDABLE_VARS:
            return os.environ.get(name, m.group(0))
        return m.group(0)  # 화이트리스트 외 → 원문 유지(→ 메타문자로 걸러짐).
    # ${VAR} 또는 $VAR 형태 매칭.
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)", _repl, token)


def _glob_prefix(token: str) -> Optional[str]:
    """glob 메타(*?[]) 포함 토큰에서 첫 메타 직전까지의 디렉터리 prefix를 반환.

    예: '~/.ssh/*' → '~/.ssh',  './*' → '.',  '/tmp/foo*.txt' → '/tmp'
    prefix가 비거나 '/' 만이면 '/' 그대로(루트 경로 후보).
    메타가 없으면 None.
    """
    import re
    m = re.search(r"[*?\[]", token)
    if m is None:
        return None
    prefix = token[: m.start()]
    # 트레일링 '/' 제거 (단, 루트 '/' 는 유지).
    if prefix.endswith("/") and len(prefix) > 1:
        prefix = prefix.rstrip("/")
    return prefix if prefix else "."


def _looks_like_path(token: str) -> bool:
    """토큰이 파일경로 후보인지 판정.

    허용:
      - '/' 또는 './' 또는 '../' 또는 '~/' 로 시작
      - '.' 또는 '..' 단독 (cwd/부모 삭제 탐지)
      - '/' 를 포함하는 상대경로
      - 확장자를 가진 상대경로 ('.' 포함, 선두 '.' 제외)
    제외:
      - 옵션 플래그(-x 류)
      - 엄격 셸 메타문자 포함 토큰
    ※ glob 메타(*?[])는 _glob_prefix 로 별도 처리하므로 여기서 걸러내지 않는다.
    """
    if not token or len(token) > 4096:
        return False
    if token.startswith("-"):
        return False
    if any(c in _SHELL_META_STRICT for c in token):
        return False
    if token in (".", ".."):
        return True
    if token.startswith(("/", "./", "../", "~/")) or token == "~":
        return True
    if "/" in token:
        return True
    if "." in token and not token.startswith("."):
        return True
    return False


def parse_terminal_paths(command: Any) -> tuple[list[str], bool]:
    """terminal command 문자열에서 경로 후보 목록을 best-effort 추출한다.

    셸을 절대 평가하지 않는다.
    반환: (paths: list[str], had_path_content: bool)
      had_path_content: 명령에 경로스러운 내용이 있었으나 추출이 비었을 때 True.

    처리 순서:
      1. shlex 토크나이즈.
      2. 각 토큰의 화이트리스트 변수($HOME 등)를 정적 전개 후 ~ 확장.
      3. glob 메타(*?[]) 포함 → _glob_prefix(디렉터리 prefix) 후보로.
      4. 메타 없음 → _looks_like_path 판정.
      5. '.' / '..' 단독도 후보(cwd/부모 삭제 탐지).
    """
    if not isinstance(command, str) or not command.strip():
        return [], False

    try:
        raw_tokens = shlex.split(command, comments=False, posix=True)
    except ValueError:
        # 따옴표 불균형 등 → 빈 목록, had_path_content=True(명령이 있었음).
        return [], bool(command.strip())

    out: list[str] = []
    seen: set[str] = set()

    def _add(tok: str) -> None:
        if tok and tok not in seen:
            seen.add(tok)
            out.append(tok)

    had_path_content = False

    for raw in raw_tokens:
        # 변수 정적 전개 + ~ 확장.
        tok = _expand_static_vars(raw)
        tok = os.path.expanduser(tok)

        # glob 메타 처리: prefix를 후보로 추출.
        pfx = _glob_prefix(tok)
        if pfx is not None:
            had_path_content = True
            # prefix 자체가 경로 후보 — 엄격 메타가 없으면 추가.
            if not any(c in _SHELL_META_STRICT for c in pfx):
                _add(pfx)
            continue

        # 메타 없는 일반 토큰.
        if _looks_like_path(tok):
            had_path_content = True
            _add(tok)

    return out, had_path_content


def extract_raw_paths(tool_name: str, args: Any) -> tuple[list[str], bool]:
    """tool_name+args에서 정규화 *전* 후보 경로 목록을 추출한다.

    반환: (paths: list[str], path_parse_miss: bool)
      path_parse_miss: 1급 파일 툴인데 경로를 못 뽑은 경우 True(가시화용).

    실측 기반 경로 키 집합 (tools/file_tools.py 실측):
      read_file   : path (required)
      write_file  : path (required)
      patch       : path (mode='replace' only; mode='patch'는 키 없음 → pathParseMiss)
      search_files: path (default ".") — 빈/미지정 시 "." 로 처리
      terminal    : command best-effort 파싱
    추가 path 키(files[], output_path, workdir 등) 없음 — 실측으로 확인됨.
    """
    if not isinstance(args, dict):
        # 1급 파일 툴인데 args 자체가 비정상
        if tool_name in FIRST_CLASS_FILE_TOOLS:
            return [], True
        return [], False

    if tool_name in ("read_file", "write_file"):
        path = args.get("path")
        if isinstance(path, str) and path:
            return [path], False
        return [], tool_name in FIRST_CLASS_FILE_TOOLS

    if tool_name == "patch":
        path = args.get("path")
        if isinstance(path, str) and path:
            return [path], False
        # mode='patch'(V4A 멀티파일): path 키 없음 → pathParseMiss.
        # V4A 텍스트 내부의 '*** Update File: ...' 경로는 셸 없이 파싱 가능하나
        # 현재 구현하지 않음(복잡도·오탐 위험, 차후 보강 포인트).
        return [], True

    if tool_name == "search_files":
        path = args.get("path") or "."  # 빈/미지정 시 cwd(".")로.
        if isinstance(path, str) and path:
            return [path], False
        return ["."], False  # 최후 폴백.

    if tool_name == "terminal":
        paths, had = parse_terminal_paths(args.get("command"))
        # terminal은 FIRST_CLASS_FILE_TOOLS가 아니므로 pathParseMiss는
        # '경로가 있었으나 못 뽑은 경우'만 True.
        return paths, (had and not paths)

    return [], False


def derive_agent_id(session_id: Optional[str], disambiguator: str = "") -> str:
    """agentId(`hermes:<disambiguator>`) 도출.

    우선순위: 명시 disambiguator > session_id 앞 12자 > 'unknown'.
    """
    if disambiguator:
        return f"hermes:{disambiguator}"
    if session_id:
        return f"hermes:{session_id[:12]}"
    return "hermes:unknown"


def _build_detail(
    tool_name: str,
    args: Any,
    extra: Optional[dict] = None,
    path_parse_miss: bool = False,
    normalize_failed: bool = False,
) -> Optional[dict]:
    """액션별 detail 객체를 구성한다 (없으면 None)."""
    detail: dict[str, Any] = {}
    if isinstance(args, dict):
        if tool_name == "terminal":
            cmd = args.get("command")
            if isinstance(cmd, str):
                detail["command"] = cmd
        elif tool_name == "search_files":
            pat = args.get("pattern")
            if isinstance(pat, str):
                detail["pattern"] = pat
            fg = args.get("file_glob")
            if isinstance(fg, str) and fg:
                detail["file_glob"] = fg
        elif tool_name == "patch":
            mode = args.get("mode", "replace")
            detail["mode"] = mode
    if path_parse_miss:
        detail["pathParseMiss"] = True
    if normalize_failed:
        detail["normalizeFailed"] = True
    if extra:
        detail.update(extra)
    return detail or None


def _short_summary(action: str, tool_name: str, paths: list[str], status: str) -> str:
    """짧은 사람용 라벨."""
    target = paths[0] if paths else tool_name
    if status == "blocked":
        return f"blocked: {action} {target}"
    if status == "cancelled":
        return f"cancelled: {action} {target}"
    return f"{action} {target}"


def build_event(
    *,
    tool_name: str,
    args: Any,
    status: str,
    session_id: Optional[str] = None,
    task_id: Optional[str] = None,
    turn_id: Optional[str] = None,
    tool_call_id: Optional[str] = None,
    disambiguator: str = "",
    cwd: Optional[str] = None,
    git_branch: Optional[str] = None,
    normalize_fn=None,
    detail_extra: Optional[dict] = None,
) -> dict:
    """hook kwargs로부터 PIVOT §3 정규화 이벤트 dict를 만든다.

    Args:
        status: started | success | error | blocked | cancelled.
        normalize_fn: 경로 정규화 콜러블(path, cwd)->Optional[str].
            None이면 원시 경로 유지.
            정규화 실패(None 반환) 시 raw 경로로 폴백 + detail.normalizeFailed=true.
        detail_extra: detail에 병합할 추가 메타(예: intervention {ruleId, mode, trigger}).
    """
    action = _map_action(tool_name, args)
    raw_paths, path_parse_miss = extract_raw_paths(tool_name, args)

    normalize_failed = False
    if normalize_fn is not None:
        norm: list[str] = []
        for p in raw_paths:
            try:
                n = normalize_fn(p, cwd)
            except Exception:
                n = None
            if n is None:
                # 정규화 실패 → raw 폴백 + 플래그.
                normalize_failed = True
                logger.debug("syncspace: normalize_path failed for %r, using raw", p)
                norm.append(p)
            else:
                norm.append(n)
        paths = norm
    else:
        paths = list(raw_paths)

    return {
        "v": 1,
        "eventId": str(uuid.uuid4()),
        "ts": now_iso_ms(),
        "agentId": derive_agent_id(session_id, disambiguator),
        "agentKind": "hermes",
        "sessionId": session_id if session_id else None,
        "taskId": task_id if task_id else None,
        "turnId": turn_id if turn_id else None,
        "action": action,
        "tool": tool_name,
        "paths": paths,
        "status": status,
        "cwd": cwd if cwd else None,
        "gitBranch": git_branch if git_branch else None,
        "correlationId": tool_call_id if tool_call_id else None,
        "summary": _short_summary(action, tool_name, paths, status),
        "detail": _build_detail(
            tool_name,
            args,
            extra=detail_extra,
            path_parse_miss=path_parse_miss,
            normalize_failed=normalize_failed,
        ),
        "visibleToUser": True,
    }
