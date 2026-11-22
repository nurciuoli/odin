#!/bin/sh
# Runs on the host as the odin user after the tarball is unpacked into ~/odin-app (macOS or Linux).
# packages/web/dist arrives pre-built; core serves it statically.
set -eu
cd "$HOME/odin-app"
[ -f packages/web/dist/index.html ] || { echo "packages/web/dist is missing from the tarball"; exit 1; }
command -v node >/dev/null || { echo "node not found for $(id -un). Install Node 24 (docs/hosting.md)."; exit 1; }

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Production dependencies of core only: no Electron, no web toolchain.
if ! corepack yarn workspaces focus @odin/core --production; then
  echo "workspaces focus failed; falling back to a full install"
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 corepack yarn install --immutable
fi

# Settings for core, loaded with node --env-file-if-exists. Created once, never overwritten.
envfile="$HOME/.odin.env"
if [ ! -f "$envfile" ]; then
  umask 077
  cat > "$envfile" <<ENV
# Odin core settings on this host. Edit, then restart core (deploy again or run deploy/restart-core.sh).
ODIN_PORT=${ODIN_CORE_PORT:-8790}
# Tailscale name of this host as served by Tailscale Serve, e.g. my-host.tailnet-name.ts.net.
# deploy/setup-tailscale-serve.sh prints the values for these two.
ODIN_EXTRA_HOSTS=
# The one Tailscale login allowed in. Leave empty until Serve is set up.
ODIN_ALLOWED_LOGIN=
ENV
  echo "Created $envfile"
fi
chmod 600 "$envfile"

sh deploy/restart-core.sh
