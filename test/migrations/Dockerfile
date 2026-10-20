FROM node:24.16.0-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git python3 make g++ procps \
    && rm -rf /var/lib/apt/lists/*

# These packages are test fixtures, never installed into the production image.
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

COPY test/migrations /tests
USER node
WORKDIR /tmp
ENV HOME=/tmp OPENCLAW_STATE_DIR=/tmp/unused MIGRATION_REPORT_DIR=/results
CMD ["node", "/tests/matrix.cjs"]
