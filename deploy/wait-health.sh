#!/bin/sh
# Runs on the host: polls core's /api/health for up to 60s and prints the response.
port=${ODIN_CORE_PORT:-8790}
i=0
while [ "$i" -lt 60 ]; do
  out=$(curl -s --max-time 2 "http://127.0.0.1:$port/api/health" || true)
  case "$out" in
    *'"app":"odin"'*) echo "$out"; exit 0 ;;
  esac
  sleep 1
  i=$((i + 1))
done
echo "odin core /api/health did not answer on port $port within 60s:"
tail -20 "$HOME/.odin-logs/core.log" 2>/dev/null
exit 1
