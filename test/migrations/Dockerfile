FROM node:24.16.0-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ procps util-linux \
    && rm -rf /var/lib/apt/lists/*

# Pin the same bridge packages as production, plus the previously shipped 9.8.
# Keep their state outside the fixture homes; lifecycle hooks can open SQLite.
ENV HOME=/tmp/install OPENCLAW_STATE_DIR=/tmp/install/state
RUN npm install -g --prefix /opt/openclaw-bridges/2026.9.5 openclaw@2026.9.5 \
    && rm -rf /tmp/install /root/.npm
RUN npm install -g --prefix /opt/openclaw-bridges/2026.9.7 openclaw@2026.9.7 \
    && rm -rf /tmp/install /root/.npm
RUN npm install -g --prefix /opt/openclaw-bridges/2026.9.8 openclaw@2026.9.8 \
    && rm -rf /tmp/install /root/.npm

ARG OPENCLAW_TARGET_VERSION
RUN test -n "$OPENCLAW_TARGET_VERSION" \
    && npm install -g --prefix /opt/openclaw-target "openclaw@$OPENCLAW_TARGET_VERSION" \
    && rm -rf /tmp/install /root/.npm

COPY package.json package-lock.json /app/
COPY migration-offline.c /tmp/migration-offline.c
RUN mkdir -p /usr/local/libexec \
    && cc -O2 -Wall -Wextra -Werror /tmp/migration-offline.c -o /usr/local/libexec/openclaw-migration-offline \
    && rm /tmp/migration-offline.c
RUN cd /app && npm ci --omit=dev \
    && ln -s /opt/openclaw-target/lib/node_modules/openclaw /usr/local/lib/node_modules/openclaw \
    && ln -s /opt/openclaw-target/lib/node_modules/openclaw/openclaw.mjs /usr/local/bin/openclaw
COPY server.cjs /app/setup-server.cjs
COPY onboard.cjs upgrade.cjs upgrade-storage.cjs upgrade-auth.cjs upgrade-runtime.mjs upgrade-worker.cjs setup.html logo.webp /app/
COPY openclaw-context /app/openclaw-context
COPY --chmod=755 bin/openclaw /app/bin/openclaw
COPY test /app/test
RUN ln -s setup-server.cjs /app/server.cjs
COPY test/migrations /tests
USER node
WORKDIR /tmp
ENV HOME=/tmp OPENCLAW_STATE_DIR=/tmp/unused MIGRATION_REPORT_DIR=/results
CMD ["node", "/tests/matrix.cjs"]
