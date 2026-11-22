#!/bin/sh
# macOS, run by an admin: sudo deploy/install-launchd.sh [user]   (default user: odin, or $ODIN_DEPLOY_USER)
# Installs core as a LaunchDaemon that runs as that user, starts at boot and restarts if it exits.
# Idempotent: running it again re-renders the plist and reloads the daemon.
set -eu
[ "$(uname)" = Darwin ] || { echo "This is for macOS. On Linux use deploy/systemd/odin-core.service."; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
user=${1:-${ODIN_DEPLOY_USER:-odin}}
here=$(cd "$(dirname "$0")" && pwd)
home=$(dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
[ -n "$home" ] || { echo "No such user: $user"; exit 1; }
[ -f "$home/odin-app/packages/core/src/index.ts" ] || { echo "Deploy first: $home/odin-app has no Odin code."; exit 1; }
group=$(id -gn "$user")
node=$(sudo -H -iu "$user" sh -c 'command -v node' | tail -n 1)
[ -n "$node" ] && [ -x "$node" ] || { echo "node not found for $user. Install Node 24 as that user."; exit 1; }
path="$(dirname "$node"):$home/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

plist=/Library/LaunchDaemons/dev.odin.core.plist
mkdir -p "$home/.odin-logs"
chown "$user" "$home/.odin-logs"
sed -e "s|__USER__|$user|g" -e "s|__GROUP__|$group|g" -e "s|__HOME__|$home|g" \
    -e "s|__NODE__|$node|g" -e "s|__PATH__|$path|g" \
    "$here/launchd/dev.odin.core.plist.template" > "$plist"
chown root:wheel "$plist"
chmod 644 "$plist"
plutil -lint "$plist"

launchctl bootout system/dev.odin.core 2>/dev/null || true
# A copy started by hand or by restart-core.sh would hold the port.
pkill -u "$user" -f "packages/core/src/index.ts" 2>/dev/null || true
launchctl bootstrap system "$plist"
echo "Installed $plist (node: $node). Logs: $home/.odin-logs/core.log"
