#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then source "$NVM_DIR/nvm.sh"; fi
fi
if command -v node >/dev/null 2>&1; then
  node "scripts/launch.mjs"
else
  echo "请先安装 Node.js 22 或更新版本。"
  read -k 1
fi
