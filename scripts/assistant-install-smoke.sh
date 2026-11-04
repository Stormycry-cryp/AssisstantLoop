#!/bin/sh
# The public installer must keep local persona edits through updates, then remove
# only its own program and command link while preserving private user data.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd -P)
work=$(mktemp -d)
cleanup() {
  code=$?
  if [ "$code" -ne 0 ] && [ -f "$work/install.log" ]; then tail -c 65536 "$work/install.log"; fi
  rm -rf "$work"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
export HOME="$work/home"
export AGENT_AUTOLOOP_HOME="$work/data"
export AGENT_AUTOLOOP_REPO="file://$repo"
unset AGENT_AUTOLOOP_RULES AGENT_AUTOLOOP_PUBLIC_URL AGENT_AUTOLOOP_COMMIT AGENT_API_KEY
mkdir -p "$HOME/.local/bin" "$work/bin"
export PATH="$work/bin:$HOME/.local/bin:$PATH"
for tool in launchctl systemctl; do
  printf '#!/bin/sh\nexit 0\n' > "$work/bin/$tool"
  chmod +x "$work/bin/$tool"
done
sh "$repo/install.sh" --preset concise --name 小助理 --owner 使用者 --skip-weixin --no-service --command true --port 3399 >"$work/install.log" 2>&1
[ -L "$HOME/.local/bin/assisstantloop" ]
[ -f "$AGENT_AUTOLOOP_HOME/persona.md" ]
[ ! -e "$AGENT_AUTOLOOP_HOME/weixin/account.json" ]
printf '\n这是用户自己的新增偏好\n' >> "$AGENT_AUTOLOOP_HOME/persona.md"
sh "$repo/install.sh" --no-service >>"$work/install.log" 2>&1
grep -q '这是用户自己的新增偏好' "$AGENT_AUTOLOOP_HOME/persona.md"
assisstantloop uninstall --yes >>"$work/install.log" 2>&1
[ ! -e "$HOME/.local/bin/assisstantloop" ]
[ ! -L "$HOME/.local/bin/assisstantloop" ]
[ ! -e "$AGENT_AUTOLOOP_HOME/app" ]
[ -f "$AGENT_AUTOLOOP_HOME/config.json" ]
grep -q '这是用户自己的新增偏好' "$AGENT_AUTOLOOP_HOME/persona.md"
echo 'assistant-install-smoke: install, persona preservation, update and uninstall passed'
