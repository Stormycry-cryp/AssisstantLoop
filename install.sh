#!/bin/sh
# Public assistant installer. Account data is separate from both source and other AutoLoop installations.
set -eu
REPO="${AGENT_AUTOLOOP_REPO:-https://github.com/Stormycry-cryp/AssisstantLoop.git}"
ROOT="${AGENT_AUTOLOOP_HOME:-${ASSISSTANTLOOP_HOME:-$HOME/.assisstantloop}}"
export AGENT_AUTOLOOP_HOME="$ROOT"
APP="$ROOT/app"
PROGRAM="$APP/bin/assisstantloop.ts"
command -v git >/dev/null || { echo '需要 Git'; exit 1; }
command -v node >/dev/null || { echo '需要 Node.js 24+，macOS 可用 brew install node@24'; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || { echo '需要 Node.js 24+，请确认 PATH 使用了新版本'; exit 1; }
mkdir -p -m 700 "$ROOT"
chmod 700 "$ROOT"
if [ -d "$APP/.git" ]; then
  origin=$(git -C "$APP" remote get-url origin)
  [ "$origin" = "$REPO" ] || { echo '现有安装来自其他仓库，保留原内容，请换一个数据目录'; exit 1; }
  [ -z "$(git -C "$APP" status --porcelain)" ] || { echo '安装源码有未保存修改，保留修改，请先处理再更新'; exit 1; }
  git -C "$APP" pull --ff-only --quiet
elif [ -e "$APP" ]; then
  echo '安装目录已有其他内容，停止覆盖'
  exit 1
else
  git clone --quiet --depth 1 -- "$REPO" "$APP"
fi
place_link() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case ":$PATH:" in *":$1:"*) ;; *) return 1 ;; esac
  if [ "$1" = "$HOME/.local/bin" ]; then mkdir -p "$1" 2>/dev/null || return 1; fi
  [ -d "$1" ] && [ -w "$1" ] || return 1
  if [ -e "$1/assisstantloop" ] || [ -L "$1/assisstantloop" ]; then
    [ -L "$1/assisstantloop" ] && [ "$1/assisstantloop" -ef "$PROGRAM" ] || return 1
  fi
  ln -sf "$PROGRAM" "$1/assisstantloop"
}
usual_ifs=$IFS
IFS=:
set -f
for place in "$HOME/.local/bin" $PATH; do if place_link "$place"; then break; fi; done
set +f
IFS=$usual_ifs
if [ -f "$ROOT/config.json" ] && [ -f "$ROOT/assistant.json" ]; then
  echo 'AssisstantLoop 更新好了，本地人设和微信账号已保留'
  case " $* " in *" --no-service "*) ;; *) "$PROGRAM" service install ;; esac
else
  "$PROGRAM" setup "$@"
fi
if ! [ "$(command -v assisstantloop || true)" -ef "$PROGRAM" ]; then
  echo "请使用完整路径运行：$PROGRAM"
  echo '以后可把对应 bin 目录加入 PATH，不需要 sudo'
fi
