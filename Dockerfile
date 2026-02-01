# OpenClaw Docker Image for Umbrel
# Self-hosted personal AI assistant with web-based setup

FROM node:22-trixie-slim

# Install system dependencies (git required for npm, others for Homebrew)
RUN apt-get update && apt-get install -y ca-certificates curl git build-essential procps file && rm -rf /var/lib/apt/lists/*

# Install OpenClaw globally from npm
RUN npm install -g openclaw@2026.1.30

# Redirect future npm global installs to persistent volume
ENV NPM_CONFIG_PREFIX=/data/.npm-global
ENV HOMEBREW_PREFIX=/data/.linuxbrew

# Set environment variables (needed?)
ENV OPENCLAW_DATA_DIR=/data/.openclaw
ENV OPENCLAW_GATEWAY_HOST=0.0.0.0
ENV OPENCLAW_GATEWAY_PORT=18789

# Switch to non-root user
USER node
ENV HOME=/data
WORKDIR /data

# Copy setup UI server
COPY --chown=node:node setup-ui/server.cjs /app/setup-server.cjs

# Run the setup/proxy server
CMD ["node", "/app/setup-server.cjs"]
EXPOSE 18789
