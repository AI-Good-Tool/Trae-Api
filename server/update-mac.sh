#!/bin/sh
set -u
trap '' HUP
pid="$1"
target="$2"
work="$3"
backup="$work/previous.app"
exec >> "$work/install.log" 2>&1
fail() { /usr/bin/printf '%s\n' "$1" > "$work/error.txt"; }
: > "$work/ready" || exit 1
attempt=0
while /bin/kill -0 "$pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 600 ]; then fail '应用未退出，已取消更新'; exit 1; fi
  /bin/sleep 0.2
done
if ! /bin/mv "$target" "$backup"; then
  fail '无法移动旧版本，更新已取消'
  /usr/bin/open -n "$target"
  exit 1
fi
if ! /bin/mv "$work/new.app" "$target"; then
  /bin/mv "$backup" "$target"
  fail '新版安装失败，已恢复旧版本'
  /usr/bin/open -n "$target"
  exit 1
fi
if ! /usr/bin/open -n "$target" --args --trae-update-stage "$work"; then
  /bin/mv "$target" "$work/failed.app"
  /bin/mv "$backup" "$target"
  fail '新版启动失败，已恢复旧版本'
  /usr/bin/open -n "$target"
  exit 1
fi
attempt=0
while [ ! -f "$work/launch-confirmed" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 150 ]; then fail "新版未确认就绪，旧版本备份保留在 $backup"; exit 1; fi
  /bin/sleep 0.2
done
# Keep the previous app and log for recovery; no account data is touched.
: > "$work/complete"
