#!/bin/sh
# Restarts Odin core on the host (runs as the odin user).
# With a launchd daemon or systemd user unit installed, killing the process is enough: the supervisor starts it again.
cd "$HOME/odin-app" || exit 1
pattern="packages/core/src/index.ts"
log="$HOME/.odin-logs/core.log"
mkdir -p "$HOME/.odin-logs"
me=$(id -u)

supervised=0
[ -f /Library/LaunchDaemons/dev.odin.core.plist ] && supervised=1
[ -f "$HOME/.config/systemd/user/odin-core.service" ] && supervised=1

if pgrep -u "$me" -f "$pattern" >/dev/null 2>&1; then
  pkill -u "$me" -f "$pattern"
  sleep 1
fi

if [ "$supervised" = 1 ]; then
  i=0
  while [ "$i" -lt 20 ]; do
    pgrep -u "$me" -f "$pattern" >/dev/null 2>&1 && break
    sleep 1
    i=$((i + 1))
  done
else
  nohup node --env-file-if-exists="$HOME/.odin.env" "$pattern" >> "$log" 2>&1 < /dev/null &
fi

sleep 2
pid=$(pgrep -u "$me" -f "$pattern" | head -n 1)
if [ -n "$pid" ]; then
  echo "odin core running (pid $pid)"
else
  echo "odin core failed to start:"
  tail -20 "$log" 2>/dev/null
  exit 1
fi
