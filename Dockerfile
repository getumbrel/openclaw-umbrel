# OpenClaw Docker Image for Umbrel
# Builds on the official OpenClaw image (ghcr.io/openclaw/openclaw) and layers
# Umbrel-specific setup, onboarding, and runtime context on top.
#
# The OPENCLAW_VERSION build arg is the only place the upstream version is set;
# the CI workflow bumps this arg on new stable releases.

ARG OPENCLAW_VERSION=2026.5.28

# ── Stage 1: Official OpenClaw image ────────────────────────────
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION} AS openclaw-base

# ── Stage 2: Umbrel layer ──────────────────────────────────────
FROM openclaw-base

USER root

# Install build tools for node-pty native module, sudo for systemctl shim,
# and ca-certificates/curl for Homebrew install.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential python3 sudo ca-certificates curl procps && \
    rm -rf /var/lib/apt/lists/*

# Install setup-server dependencies (node-pty, ws).
# Use cp -r (not cp -rn) so version conflicts surface during build.
WORKDIR /app/umbrel-layer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    cp -r node_modules/* /app/node_modules/ && \
    rm -rf /app/umbrel-layer
WORKDIR /app

# Purge build toolchain — no longer needed after node-pty compilation
RUN apt-get purge -y --auto-remove build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

# Pre-create /home/linuxbrew directory with correct ownership so Homebrew
# can install into it as the node user. The Umbrel compose file bind-mounts
# a persistent volume over this directory at runtime.
RUN mkdir -p /home/linuxbrew && \
    chown node:node /home/linuxbrew

# Install Homebrew as the node user (Homebrew refuses to run as root).
USER node
RUN /bin/bash -c "NONINTERACTIVE=1 $(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
USER root

# Shim systemctl for Docker — there's no systemd in the container, but OpenClaw's
# agent calls `systemctl --user restart openclaw-gateway` to restart the gateway.
# This script skips flags like --user to find the subcommand (restart/stop/start),
# then kills the gateway process by its process title ("openclaw-gateway").
RUN printf '#!/bin/bash\ncmd=""\nfor arg in "$@"; do\n  case "$arg" in\n    -*) ;;\n    *) cmd="$arg"; break ;;\n  esac\ndone\ncase "$cmd" in\n  restart|stop) pkill -f "^openclaw-gateway([[:space:]]|$)" 2>/dev/null || true ;;\n  start) echo "openclaw-gateway is managed by the container" ;;\n  *) exit 0 ;;\nesac\n' | tee /usr/local/bin/systemctl \
    && chmod +x /usr/local/bin/systemctl

# Replace apt/apt-get with script telling openclaw to use brew instead
RUN printf '#!/bin/bash\necho "Error: apt is not available. Please use brew instead." >&2\necho "Example: brew install <package>" >&2\nexit 1\n' | tee /usr/local/bin/use-brew \
    && chmod +x /usr/local/bin/use-brew \
    && ln -sf /usr/local/bin/use-brew /usr/local/bin/apt \
    && ln -sf /usr/local/bin/use-brew /usr/local/bin/apt-get

# Copy setup UI server, static files, and managed Umbrel context
COPY --chown=node:node server.cjs /app/setup-server.cjs
COPY --chown=node:node setup.html /app/setup.html
COPY --chown=node:node logo.webp /app/logo.webp
COPY openclaw-context /app/openclaw-context

# Create required directories with correct ownership.
# /home-skeleton is the template for first-run home directory setup.
RUN mkdir -p /data /home-skeleton && \
    chown node:node /data /home-skeleton && \
    echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Move default home to skeleton so first-run copies it for the node user.
# Use || true (not ; exit 0) so only the mv failure is suppressed.
RUN mv /data /home-skeleton/data 2>/dev/null || true

# NPM global installs go to the persistent volume
ENV NPM_CONFIG_PREFIX=/data/.npm-global

# Setup PATH
ENV PATH="/data/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/bin:/usr/bin:/bin"

# Switch to non-root user
USER node

# Run the setup/proxy server
CMD ["node", "/app/setup-server.cjs"]
EXPOSE 18789
