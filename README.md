<div align=center><a href="https://apps.umbrel.com/app/openclaw"><img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/openclaw.png" alt="OpenClaw" height="60"></a></div>

# OpenClaw for umbrelOS

> A Docker image for running [OpenClaw](https://openclaw.ai) on umbrelOS.

⚠️ WARNING: Running this on systems other than umbrelOS is likely very insecure. This configuration is only secure when running behind the umbrelOS app proxy.

## Architecture

The image builds on the **official OpenClaw container image** (`ghcr.io/openclaw/openclaw`) and layers Umbrel-specific components on top:

1. **Base**: `ghcr.io/openclaw/openclaw:$VERSION` — the full OpenClaw gateway with all bundled extensions
2. **Umbrel layer**: setup server (`server.cjs`), onboarding UI, `umbrel-runtime` plugin, `node-pty` for terminal access, and a `systemctl` shim

This approach means the Umbrel image automatically inherits upstream improvements (Node.js version bumps, extension updates, security patches) by simply bumping the `OPENCLAW_VERSION` build arg.

## Version Tracking

| Component | Version source |
|-----------|---------------|
| OpenClaw gateway | `OPENCLAW_VERSION` build arg in `Dockerfile` |
| Official base image | `ghcr.io/openclaw/openclaw:$OPENCLAW_VERSION` |
| Umbrel layer | Files in this repo (`server.cjs`, `openclaw-context/`, etc.) |

## Automated Updates

Three GitHub Actions workflows handle the release pipeline:

1. **OpenClaw Release PR** (daily at 06:00 UTC): Checks `openclaw/openclaw` GitHub releases for the latest stable version. If a new stable release is found, creates a draft PR that bumps `OPENCLAW_VERSION` in the Dockerfile.

2. **Tag on Merge**: When an `openclaw-update` PR is merged, tags the merge commit with the new version number.

3. **Docker Build and Push**: When a version tag is pushed, builds multi-arch images (amd64 + arm64) and pushes to `ghcr.io/getumbrel/openclaw-umbrel`.

PRs are created as **drafts** so a human can review upstream release notes for breaking changes before publishing.

## Local Development

```bash
# Build with a specific OpenClaw version
docker compose build --build-arg OPENCLAW_VERSION=2026.5.28

# Run
docker compose up -d
```

## Config Migrations

When upgrading to a new OpenClaw version, some config keys may change (e.g., API type renames, plugin entry points). The setup server runs `openclaw doctor --repair` before gateway start to handle migrations automatically. If doctor hangs on large bind mounts, you can bypass it by overriding the container command:

```yaml
command: ["node", "/app/openclaw.mjs", "gateway", "--port", "18789"]
```
