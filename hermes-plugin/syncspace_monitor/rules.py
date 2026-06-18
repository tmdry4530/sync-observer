"""규칙엔진 — 경로 allow/deny 평가 (stdlib only).

설계 결정 (PIVOT Q6, 잠금됨):
  - 기본 정책 = allow (미지정 경로 허용).
  - deny-overrides: deny가 allow를 이긴다.
  - 경로 매칭은 realpath 정규화한 절대 POSIX 경로 기준
    (심볼릭링크/상대경로 우회 차단, 상대경로는 cwd 기준, `~` 확장).
  - glob 문법은 stdlib만으로 직접 구현:
      `**` = 경로구분자(/)를 가로지름,
      `*`  = 세그먼트 내(/ 제외),
      `?`  = 한 글자(/ 제외).
    매칭은 .match() + \\Z 앵커(전체 일치)로 평가한다.
  - 대소문자 무시 FS(macOS/Windows): _CASE_INSENSITIVE_FS=True면 re.IGNORECASE.
    env SYNCSPACE_CASE_INSENSITIVE=1/0 으로 override 가능.
  - 유니코드 NFC 정규화: 경로와 glob 패턴 양쪽을 NFC로 통일해 NFD 우회 방어.
  - scope = global | session:<id> | agent:<id>.

규칙 소스: SYNCSPACE_RULES_FILE(JSON) 로드 + mtime 기반 변경 감지 리로드.
JSON 형식:
    {"rules": [
        {"id": "r1", "kind": "deny", "glob": "/Users/me/.ssh/**",
         "scope": "global", "enabled": true},
        ...
    ]}
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import unicodedata
from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# 대소문자 무시 FS 플래그
# ---------------------------------------------------------------------------

def _detect_case_insensitive() -> bool:
    """플랫폼 기본값(macOS/Windows=대소문자 무시) + env override."""
    env = os.environ.get("SYNCSPACE_CASE_INSENSITIVE", "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        return True
    if env in ("0", "false", "no", "off"):
        return False
    return sys.platform in ("darwin", "win32")

_CASE_INSENSITIVE_FS: bool = _detect_case_insensitive()


def _nfc(s: str) -> str:
    """유니코드 NFC 정규화(NFD 우회 방어). 빈/비문자열은 그대로."""
    if not isinstance(s, str) or not s:
        return s
    return unicodedata.normalize("NFC", s)


# ---------------------------------------------------------------------------
# glob 매처 (stdlib만)
# ---------------------------------------------------------------------------

# 캐시: (pattern, case_insensitive) 키로 재컴파일 방지 (규칙 평가는 핫패스).
_GLOB_CACHE: dict[tuple[str, bool], "re.Pattern[str]"] = {}
_GLOB_CACHE_LOCK = threading.Lock()


def _compile_glob(pattern: str, case_insensitive: bool = False) -> "re.Pattern[str]":
    """glob 패턴을 정규식으로 컴파일한다.

    의미론:
        **  -> 임의 문자(/ 포함). 단독 '/**' 형태는 0개 세그먼트도 매칭
              (권장: '/**' 뒤에 배치. '/x**' 같은 비표준은 세그먼트 중간에서
               과대매칭이 발생할 수 있어 사용을 권장하지 않는다).
        *   -> / 를 제외한 임의 문자(0개 이상)
        ?   -> / 를 제외한 한 글자
        나머지 문자는 리터럴(정규식 이스케이프).
    매칭은 .match() + \\Z 앵커 = 전체 일치로 평가한다.
    case_insensitive=True면 re.IGNORECASE 적용(대소문자 무시 FS용).
    """
    cache_key = (pattern, case_insensitive)
    cached = _GLOB_CACHE.get(cache_key)
    if cached is not None:
        return cached

    out: list[str] = []
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            # '**' 처리
            if i + 1 < n and pattern[i + 1] == "*":
                # '/**' 형태면 0개 세그먼트도 허용 → '/'까지 선택적으로 흡수.
                if out and out[-1] == "/":
                    # 직전에 추가한 리터럴 '/'를 회수하고 선택적 그룹으로 대체.
                    out.pop()
                    out.append("(?:/.*)?")
                else:
                    out.append(".*")
                i += 2
                # '**' 뒤에 곧바로 '/'가 오면 그 '/'는 위 그룹에 흡수되므로 스킵.
                if i < n and pattern[i] == "/" and out[-1] == "(?:/.*)?":
                    i += 1
                continue
            # 단일 '*' : / 제외 0개 이상
            out.append("[^/]*")
            i += 1
            continue
        if ch == "?":
            out.append("[^/]")
            i += 1
            continue
        # 리터럴 (정규식 메타 이스케이프)
        out.append(re.escape(ch))
        i += 1

    flags = re.IGNORECASE if case_insensitive else 0
    regex = re.compile("".join(out) + r"\Z", flags)
    with _GLOB_CACHE_LOCK:
        _GLOB_CACHE[cache_key] = regex
    return regex


def glob_match(pattern: str, path: str) -> bool:
    """정규화된 절대 POSIX path가 glob pattern에 매칭되는지.

    - 양쪽을 NFC로 정규화해 NFD 우회를 방어한다.
    - _CASE_INSENSITIVE_FS=True면 대소문자 무시 매칭.
    """
    if not pattern or not path:
        return False
    try:
        p = _nfc(pattern)
        s = _nfc(path)
        return _compile_glob(p, _CASE_INSENSITIVE_FS).match(s) is not None
    except re.error:
        # 손상된 패턴은 매칭 실패로 안전 폴백 (예외 던지지 않음).
        return False


# ---------------------------------------------------------------------------
# 경로 정규화
# ---------------------------------------------------------------------------

def normalize_path(path: str, cwd: Optional[str] = None) -> Optional[str]:
    """경로를 realpath 정규화한 절대 POSIX 경로로 변환한다.

    - `~` 확장
    - 상대경로는 cwd(없으면 os.getcwd()) 기준으로 해소
    - 심볼릭링크 realpath 해소 (우회 차단)
    - 유니코드 NFC 정규화 (NFD 우회 방어)
    실패 시 None 반환(예외 없음).
    """
    if not path or not isinstance(path, str):
        return None
    try:
        expanded = os.path.expanduser(_nfc(path))
        if not os.path.isabs(expanded):
            base = cwd if cwd else os.getcwd()
            expanded = os.path.join(base, expanded)
        # realpath: 존재하지 않는 경로도 가능한 만큼 정규화(심볼릭링크 해소).
        real = os.path.realpath(expanded)
        # 윈도우 호환을 위해 POSIX 구분자로 통일 + NFC.
        return _nfc(real.replace(os.sep, "/"))
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------------------
# 규칙 모델 / 결정
# ---------------------------------------------------------------------------

_VALID_KINDS = {"allow", "deny"}


@dataclass(frozen=True)
class Rule:
    """단일 경로 정책 규칙.

    Attributes:
        id: 규칙 식별자 (block 메시지/개입 로그에 사용).
        kind: "allow" | "deny".
        glob: 정규화된 절대 POSIX 경로에 매칭할 glob 패턴.
        scope: "global" | "session:<id>" | "agent:<id>".
        enabled: False면 평가에서 제외.
    """

    id: str
    kind: str
    glob: str
    scope: str = "global"
    enabled: bool = True

    def applies_to(self, session_id: Optional[str], agent_id: Optional[str]) -> bool:
        """현재 scope 컨텍스트에 이 규칙이 적용되는지."""
        if not self.enabled:
            return False
        scope = self.scope or "global"
        if scope == "global":
            return True
        if scope.startswith("session:"):
            return session_id is not None and scope[len("session:"):] == session_id
        if scope.startswith("agent:"):
            return agent_id is not None and scope[len("agent:"):] == agent_id
        # 알 수 없는 scope는 안전하게 미적용.
        return False


@dataclass(frozen=True)
class Decision:
    """규칙 평가 결과.

    Attributes:
        allowed: 최종 허용 여부 (기본 allow, deny-overrides 적용 후).
        rule_id: 결정을 내린 규칙 id (deny 매치 시 그 규칙, 아니면 None).
        matched_kind: 매치된 규칙 종류 ("deny"|"allow") 또는 None(기본 정책).
    """

    allowed: bool
    rule_id: Optional[str] = None
    matched_kind: Optional[str] = None


def _coerce_rule(raw: object) -> Optional[Rule]:
    """JSON dict 하나를 Rule로 변환. 형식 불량은 None(스킵)."""
    if not isinstance(raw, dict):
        return None
    rid = raw.get("id")
    kind = raw.get("kind")
    glob = raw.get("glob")
    if not isinstance(rid, str) or not rid:
        return None
    if kind not in _VALID_KINDS:
        return None
    if not isinstance(glob, str) or not glob:
        return None
    scope = raw.get("scope", "global")
    if not isinstance(scope, str) or not scope:
        scope = "global"
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        enabled = bool(enabled)
    return Rule(id=rid, kind=kind, glob=glob, scope=scope, enabled=enabled)


def evaluate(
    rules: list[Rule],
    path: str,
    session_id: Optional[str] = None,
    agent_id: Optional[str] = None,
) -> Decision:
    """정규화된 path에 대해 규칙 목록을 평가한다.

    의미론: 기본 allow + deny-overrides.
      - scope에 적용되는 규칙만 평가.
      - deny 매치가 하나라도 있으면 즉시 차단(첫 deny 매치 id 반환).
      - deny 없고 allow 매치 있으면 명시 허용(allow rule id).
      - 아무 매치 없으면 기본 정책 allow.
    """
    matched_allow: Optional[Rule] = None
    for rule in rules:
        if not rule.applies_to(session_id, agent_id):
            continue
        if not glob_match(rule.glob, path):
            continue
        if rule.kind == "deny":
            # deny-overrides: 즉시 차단.
            return Decision(allowed=False, rule_id=rule.id, matched_kind="deny")
        if matched_allow is None:
            matched_allow = rule
    if matched_allow is not None:
        return Decision(allowed=True, rule_id=matched_allow.id, matched_kind="allow")
    # 기본 정책 = allow.
    return Decision(allowed=True, rule_id=None, matched_kind=None)


# ---------------------------------------------------------------------------
# RuleStore — JSON 로드 + mtime 리로드 (스레드 안전 compare-and-commit)
# ---------------------------------------------------------------------------

class RuleStore:
    """규칙 JSON 파일을 로드하고 mtime 변경 시 리로드하는 저장소.

    스레드 안전: pre_tool_call이 멀티스레드에서 발화하므로 락으로 보호.
    mtime 읽기·비교·할당을 단일 락으로 감싸 리로드 레이스를 제거한다
    (파싱은 락 밖에서 하되 compare-and-commit은 락 안).
    파일 미설정/부재/파싱 실패 시 빈 규칙 목록(= 전부 허용)으로 폴백.
    """

    def __init__(self, rules_file: str = "") -> None:
        self._rules_file = rules_file or ""
        self._rules: list[Rule] = []
        self._mtime: Optional[float] = None
        self._lock = threading.Lock()
        # 최초 1회 로드 시도.
        self._reload_if_changed()

    def _reload_if_changed(self) -> None:
        """파일 mtime이 바뀌었으면 다시 로드한다 (실패는 조용히 스킵).

        compare-and-commit 패턴:
          1. mtime 읽기 + 이전 mtime 비교 → 락 안에서.
          2. 파싱(파일 IO, JSON) → 락 밖(느린 작업 격리).
          3. 결과 커밋(rules + mtime 갱신) → 락 안에서.
        """
        path = self._rules_file
        if not path:
            return
        # 1. mtime 읽기 + 조기 탈출 판정 (락 안).
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            # 파일 부재/접근불가 → 기존 규칙 유지.
            return
        with self._lock:
            if self._mtime is not None and mtime == self._mtime:
                return
            # 파싱 중 다른 스레드가 또 진입하지 않도록 mtime을 새 값으로 예약.
            prev_mtime = self._mtime
            self._mtime = mtime  # optimistic: 파싱 실패 시 롤백.

        # 2. 파싱 (락 밖 — 느린 IO).
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            raw_rules = data.get("rules") if isinstance(data, dict) else None
            if not isinstance(raw_rules, list):
                raw_rules = []
            parsed = [r for r in (_coerce_rule(item) for item in raw_rules) if r is not None]
        except (OSError, ValueError):
            # 파싱 실패: mtime 롤백 + 기존 규칙 유지.
            with self._lock:
                self._mtime = prev_mtime
            return

        # 3. 커밋 (락 안).
        with self._lock:
            self._rules = parsed
            # mtime은 이미 1단계에서 갱신됨 — 재확인해 최신값 유지.
            self._mtime = mtime

    def get_rules(self) -> list[Rule]:
        """현재 규칙 목록 스냅샷을 반환(필요 시 리로드)."""
        self._reload_if_changed()
        with self._lock:
            return list(self._rules)

    def evaluate(
        self,
        path: str,
        session_id: Optional[str] = None,
        agent_id: Optional[str] = None,
    ) -> Decision:
        """경로 1건을 평가한다(리로드 포함)."""
        return evaluate(self.get_rules(), path, session_id, agent_id)
