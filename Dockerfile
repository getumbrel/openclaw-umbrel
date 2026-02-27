# OpenClaw Docker Image for Umbrel
# Self-hosted personal AI assistant with web-based setup

FROM node:22-trixie-slim

# Install global deps
RUN apt-get update && apt-get install -y --no-install-recommends sudo ca-certificates curl git build-essential python3 procps file chromium && rm -rf /var/lib/apt/lists/*

# Set home directory
ENV HOME=/data
WORKDIR /data
RUN mkdir -p /data && chown node:node /data

# Install OpenClaw globally from npm
RUN npm install -g openclaw@2026.2.25

# Redirect future npm global installs to persistent volume
ENV NPM_CONFIG_PREFIX=/data/.npm-global

# Install setup server dependencies (node-pty needs build tools, do this as root)
COPY package.json package-lock.json /app/
RUN cd /app && npm ci --omit=dev && chown -R node:node /data

# Switch to non-root user
RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER node

# Install brew
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Shim systemctl for Docker — there's no systemd in the container, but OpenClaw's
# agent calls `systemctl --user restart openclaw-gateway` to restart the gateway.
# This script skips flags like --user to find the subcommand (restart/stop/start),
# then kills the gateway process by its process title ("openclaw-gateway").
# The container's `restart: unless-stopped` policy brings everything back.
# `|| true` prevents pkill's non-zero exit code from making the restart look like
# a failure to the agent. The pkill target matches the gateway's runtime process
# title, not the binary name — if the OpenClaw version changes, verify with `ps aux`.
RUN printf '#!/bin/bash\n# Skip flags (e.g. --user) to find the actual subcommand\ncmd=""\nfor arg in "$@"; do\n  case "$arg" in\n    -*) ;;\n    *) cmd="$arg"; break ;;\n  esac\ndone\ncase "$cmd" in\n  restart|stop) pkill -f "openclaw-gateway" 2>/dev/null || true ;;\n  start) echo "openclaw-gateway is managed by the container" ;;\n  *) exit 0 ;;\nesac\n' | sudo tee /usr/local/bin/systemctl \
    && sudo chmod +x /usr/local/bin/systemctl

# Replace apt/apt-get with script telling openclaw to use brew
RUN printf '#!/bin/bash\necho "Error: apt is not available. Please use brew instead." >&2\necho "Example: brew install <package>" >&2\nexit 1\n' | sudo tee /usr/local/bin/use-brew \
    && sudo chmod +x /usr/local/bin/use-brew \
    && sudo ln -s /usr/local/bin/use-brew /usr/local/bin/apt \
    && sudo ln -s /usr/local/bin/use-brew /usr/local/bin/apt-get

# Copy setup UI server and static files
COPY --chown=node:node server.cjs /app/setup-server.cjs
COPY --chown=node:node setup.html /app/setup.html
COPY --chown=node:node logo.webp /app/logo.webp

# Move home to skeleton
RUN sudo mv /data /home-skeleton
RUN sudo mv /home/linuxbrew /home-skeleton/linuxbrew

# Setup PATH
ENV PATH="/data/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# Run the setup/proxy server
CMD ["node", "/app/setup-server.cjs"]
EXPOSE 18789
