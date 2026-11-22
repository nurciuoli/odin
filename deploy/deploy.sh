#!/bin/sh
# Deploys Odin from this computer (macOS or Linux) to the host. Settings come from deploy/host.env.local.
# Usage: deploy/deploy.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
envfile="$here/host.env.local"
[ -f "$envfile" ] || { echo "Missing $envfile. Copy deploy/host.env.example to it and edit."; exit 1; }
set -a
# shellcheck disable=SC1090
. "$envfile"
set +a
: "${ODIN_DEPLOY_HOST:?set ODIN_DEPLOY_HOST in host.env.local}"
user=${ODIN_DEPLOY_USER:-odin}
core_port=${ODIN_CORE_PORT:-8790}
target="$user@$ODIN_DEPLOY_HOST"
tgz="${TMPDIR:-/tmp}/odin-deploy.tgz"

cd "$root"
echo "Building web..."
corepack yarn build:web
[ -f packages/web/dist/index.html ] || { echo "packages/web/dist/index.html missing after build"; exit 1; }

echo "Packing..."
tar -czf "$tgz" \
  --exclude=node_modules --exclude=.git --exclude=.worktrees --exclude=.yarn/cache \
  --exclude=apps/desktop/stage --exclude=apps/desktop/dist --exclude=packages/core/dist --exclude=packages/shared/dist \
  package.json yarn.lock .yarnrc.yml tsconfig.json packages apps adapters templates deploy docs

echo "Uploading to $target..."
scp -q -o BatchMode=yes "$tgz" "$target:/tmp/odin-deploy.tgz"
echo "Installing..."
ssh -o BatchMode=yes "$target" "rm -rf ~/odin-app/packages/web/dist && mkdir -p ~/odin-app && tar -xzf /tmp/odin-deploy.tgz -C ~/odin-app && ODIN_CORE_PORT=$core_port \$SHELL -l -c 'sh ~/odin-app/deploy/remote-install.sh'"
echo "Waiting for core /api/health (up to 60s)..."
ssh -o BatchMode=yes "$target" "ODIN_CORE_PORT=$core_port \$SHELL -l -c 'sh ~/odin-app/deploy/wait-health.sh'"
echo "Deployed."
