#!/usr/bin/env bash
# sync-observer 한 줄 설치기.
#   curl -fsSL https://raw.githubusercontent.com/tmdry4530/sync-observer/main/install.sh | bash
#
# 하는 일: 레포 클론/업데이트 → 의존성 설치 → hermes 플러그인 자동 심링크+enable
#          → 'observer' 런처를 PATH에 설치. 이후 'observer' 한 단어로 전체 기동.
set -euo pipefail

REPO_URL="${SYNC_OBSERVER_REPO:-https://github.com/tmdry4530/sync-observer.git}"
INSTALL_DIR="${SYNC_OBSERVER_DIR:-$HOME/.sync-observer}"
BIN_DIR="${SYNC_OBSERVER_BIN:-$HOME/.local/bin}"
PLUGIN_LINK="$HOME/.hermes/plugins/syncspace-monitor"

info() { printf '\033[1;36m[observer]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[observer]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[observer]\033[0m %s\n' "$*" >&2; exit 1; }

# 1) 필수 도구
missing=""
for c in git node pnpm python3; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
[ -n "$missing" ] && die "필수 도구 없음:$missing (설치 후 다시 실행)"
HAS_HERMES=0; command -v hermes >/dev/null 2>&1 && HAS_HERMES=1
[ "$HAS_HERMES" = 1 ] || warn "hermes 미설치 — 컬렉터/UI는 동작하지만 플러그인 연결은 건너뜁니다."

# 2) 클론 또는 업데이트
if [ -d "$INSTALL_DIR/.git" ]; then
  info "기존 설치 업데이트: $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin main -q && git -C "$INSTALL_DIR" reset --hard origin/main -q
else
  info "클론: $REPO_URL → $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" -q
fi

# 3) 의존성
info "의존성 설치 (pnpm install) — 처음엔 수 분 걸릴 수 있습니다…"
( cd "$INSTALL_DIR" && pnpm install --silent )

# 4) hermes 플러그인 자동 연결
if [ "$HAS_HERMES" = 1 ]; then
  mkdir -p "$HOME/.hermes/plugins"
  if [ -L "$PLUGIN_LINK" ] || [ -e "$PLUGIN_LINK" ]; then
    info "플러그인 이미 연결됨: $PLUGIN_LINK"
  else
    ln -s "$INSTALL_DIR/hermes-plugin" "$PLUGIN_LINK" && info "플러그인 심링크 생성"
  fi
  if hermes plugins enable syncspace-monitor >/dev/null 2>&1; then
    info "플러그인 enable 완료 (hermes 세션 한 번 재시작 필요)"
  else
    warn "플러그인 enable 실패 — 수동: hermes plugins enable syncspace-monitor"
  fi
fi

# 5) observer 런처 설치
mkdir -p "$BIN_DIR"
install -m 0755 "$INSTALL_DIR/bin/observer" "$BIN_DIR/observer"
info "observer 설치: $BIN_DIR/observer"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR 가 PATH에 없습니다. 셸 설정에 추가하세요: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

info "완료! 이제 아래 한 단어로 전체 시스템이 실행됩니다:"
printf '\n    \033[1;32mobserver\033[0m\n\n'
info "(컬렉터 + 모니터 UI 기동 → 브라우저 자동 열림. 중지: observer stop)"
