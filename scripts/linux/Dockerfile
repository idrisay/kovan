# Kovan on Linux: a container that builds the app and runs its smoke tests on
# a virtual display (Xvfb). Used locally from a Mac (`scripts/linux/run.sh`)
# and meant for CI. Debian bookworm, Node 22.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      # node-pty compiles from source
      python3 make g++ \
      # Electron's runtime libraries and a display
      xvfb xauth libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxshmfence1 \
      libdrm2 libx11-xcb1 libxtst6 libatspi2.0-0 libsecret-1-0 dbus dbus-x11 \
      # what Kovan shells out to
      git zsh procps lsof sqlite3 ca-certificates \
      # packaging: .deb needs fakeroot and dpkg, AppImage needs nothing more
      fakeroot dpkg rpm ruby \
    && rm -rf /var/lib/apt/lists/* \
    # electron-builder's own fpm is an x86 binary; on arm64 it needs the system one.
    && gem install fpm --no-document

# Chromium refuses to run as root without --no-sandbox; a normal user keeps
# the run closer to a real desktop.
RUN useradd -m -s /bin/bash kovan \
 && mkdir -p /home/kovan/work/node_modules /home/kovan/.npm /home/kovan/out \
 && chown -R kovan:kovan /home/kovan
USER kovan
WORKDIR /home/kovan/work
