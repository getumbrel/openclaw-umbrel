# OpenClaw Docker Image for Umbrel
# Self-hosted personal AI assistant with web-based setup

FROM node:22-bookworm-slim

# Installbrew requirements
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    tini \
    git \
    build-essential \
    procps \
    file \
    && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally from npm
RUN npm install -g openclaw@latest

# Copy setup UI server
COPY --chown=node:node setup-ui/server.cjs /app/setup-server.cjs

# Set environment variables
ENV NODE_ENV=production
ENV HOME=/home/node
ENV HOMEBREW_PREFIX=/home/node/.linuxbrew
ENV PATH="${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin:${PATH}"
ENV OPENCLAW_DATA_DIR=/home/node/.openclaw
ENV OPENCLAW_GATEWAY_HOST=0.0.0.0
ENV OPENCLAW_GATEWAY_PORT=18789

WORKDIR /app

# Expose gateway port
EXPOSE 18789

# Switch to non-root user
USER node

# Use tini as init system
ENTRYPOINT ["/usr/bin/tini", "--"]

# Run the setup/proxy server
CMD ["node", "/app/setup-server.cjs"]
