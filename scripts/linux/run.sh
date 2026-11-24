#!/usr/bin/env bash
# Builds Kovan inside the Linux container and runs a command there.
#   scripts/linux/run.sh                 # install, build, typecheck, test
#   scripts/linux/run.sh smoke seeded    # …then a smoke run under Xvfb
#   scripts/linux/run.sh pack            # …then AppImage and .deb into release-linux/
#   KOVAN_ARCH=x64 scripts/linux/run.sh pack   # x64 on an arm64 Mac (emulated, slow)
# The repository is copied in (never mounted read-write), so the Mac's
# node_modules, built for macOS, are left alone. Linux's are installed fresh
# each run (npm ci empties the folder, which a mounted volume can't take);
# the npm cache volume keeps that quick.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
arch="${KOVAN_ARCH:-arm64}"
platform=$([ "$arch" = x64 ] && echo linux/amd64 || echo linux/arm64)
image="kovan-linux-$arch"
docker build -q --platform "$platform" -t "$image" "$here/scripts/linux" >/dev/null
docker run --rm -i --platform "$platform" \
  -v "$here":/src:ro \
  -v "kovan-linux-npm-$arch":/home/kovan/.npm \
  -v "$here/apps/desktop/release-linux":/home/kovan/out \
  -e KOVAN_STEP="${1:-check}" -e KOVAN_ARG="${2:-}" -e KOVAN_ITEM="${3:-}" -e KOVAN_ARCH="$arch" \
  "$image" bash -s <<'INNER'
set -euo pipefail
cd /home/kovan/work
# Source only: no node_modules, build output or releases from the Mac.
tar -C /src --exclude=node_modules --exclude=out --exclude='release*' --exclude=dist \
    --exclude='*.tsbuildinfo' --exclude=.git -cf - . | tar -xf -
npm ci --no-audit --no-fund --loglevel=error
npm run typecheck >/dev/null && echo "typecheck ok"
npx vitest run 2>&1 | grep -E "Tests |Test Files |FAIL|✗|×" | head -20
case "$KOVAN_STEP" in
  smoke)
    cd apps/desktop
    npx electron-vite build >/dev/null
    rm -rf /tmp/kovan-smoke /tmp/kovan-repo && mkdir -p /tmp/kovan-smoke /tmp/kovan-repo
    git -C /tmp/kovan-repo init -q
    echo '{"repos.folders":["/tmp/kovan-repo"]}' > /tmp/kovan-smoke/settings.json
    # `run.sh smoke seeded KOVAN_SMOKE_ITEM129` drives one item; shots land in out/.
    [ -n "$KOVAN_ITEM" ] && export "$KOVAN_ITEM=/home/kovan/out/${KOVAN_ITEM#KOVAN_SMOKE_}"
    # A desktop session has a private runtime folder; give the container one.
    export XDG_RUNTIME_DIR=/tmp/runtime-kovan && mkdir -p -m 700 "$XDG_RUNTIME_DIR"
    KOVAN_SMOKE="${KOVAN_ARG:-seeded}" KOVAN_USER_DATA=/tmp/kovan-smoke \
      xvfb-run -a -s "-screen 0 1440x900x24" dbus-run-session -- npx electron --no-sandbox . 2>&1 | tail -60
    cp /tmp/kovan-smoke/*.png /home/kovan/out/ 2>/dev/null || true ;;
  pack)
    # electron-builder starts its helper inside the app's own node_modules;
    # npm hoists everything to the root, so that folder may not exist.
    mkdir -p apps/desktop/node_modules
    cd apps/desktop
    npm run build >/dev/null
    USE_SYSTEM_FPM=true npx electron-builder --linux AppImage deb "--$KOVAN_ARCH" -c.directories.output=/home/kovan/out 2>&1 | tail -15 ;;
esac
INNER
