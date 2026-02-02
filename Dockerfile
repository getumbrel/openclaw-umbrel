# OpenClaw Docker Image for Umbrel
# Self-hosted personal AI assistant with web-based setup

FROM node:22-trixie-slim

# Install global deps and give node user sudo access
RUN apt-get update && apt-get install -y sudo ca-certificates curl git build-essential procps file && rm -rf /var/lib/apt/lists/*

# Set home directory
ENV HOME=/data
WORKDIR /data
RUN mkdir -p /data && chown node:node /data

# Install OpenClaw globally from npm
RUN npm install -g openclaw@2026.1.30

# Redirect future npm global installs to persistent volume
ENV NPM_CONFIG_PREFIX=/data/.npm-global

# Switch to non-root user
RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER node

# Install brew
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Copy setup UI server
COPY --chown=node:node server.cjs /app/setup-server.cjs

# Move home to skeleton
RUN sudo mv /data /home-skeleton
RUN sudo mv /home/linuxbrew /home-skeleton/linuxbrew

# Setup PATH
ENV PATH="/data/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

# Run the setup/proxy server
CMD ["node", "/app/setup-server.cjs"]
EXPOSE 18789
