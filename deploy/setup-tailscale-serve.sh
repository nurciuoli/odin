#!/bin/sh
# Run by an admin on the host. Exposes core (127.0.0.1) on the tailnet over HTTPS with Tailscale Serve.
# Idempotent: running it again re-applies the same config.
# Settings (environment): ODIN_CORE_PORT (default 8790), ODIN_SERVE_PORT (default 8443).
set -eu
core_port=${ODIN_CORE_PORT:-8790}
serve_port=${ODIN_SERVE_PORT:-8443}
TS=$(command -v tailscale || true)
if [ -z "$TS" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
fi
[ -n "$TS" ] || { echo "tailscale CLI not found (not on PATH, not in /Applications/Tailscale.app)"; exit 1; }
echo "Using $TS"
echo "Running: tailscale serve --bg --https=$serve_port http://127.0.0.1:$core_port"
"$TS" serve --bg --https="$serve_port" "http://127.0.0.1:$core_port"
echo
echo "Current serve status:"
"$TS" serve status
echo

if command -v node >/dev/null; then
  "$TS" status --json | SERVE_PORT="$serve_port" node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const j = JSON.parse(s);
      const host = String(j.Self?.DNSName ?? "").replace(/\.$/, "");
      const login = j.User?.[String(j.Self?.UserID)]?.LoginName ?? "";
      const port = process.env.SERVE_PORT;
      console.log("Open: https://" + host + (port === "443" ? "" : ":" + port) + "/");
      console.log("Put these in ~/.odin.env on the host, then restart core:");
      console.log("ODIN_EXTRA_HOSTS=" + host);
      console.log("ODIN_ALLOWED_LOGIN=" + login);
    });
  '
else
  echo "node not found for this user; read the values from: tailscale status --json"
  echo "  ODIN_EXTRA_HOSTS = Self.DNSName without the trailing dot"
  echo "  ODIN_ALLOWED_LOGIN = the LoginName of the user in Self.UserID"
fi
echo
echo "To turn it off: tailscale serve --https=$serve_port off"
