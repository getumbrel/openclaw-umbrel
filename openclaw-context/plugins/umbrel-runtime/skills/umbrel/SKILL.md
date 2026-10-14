---
name: umbrel
description: Use when working with OpenClaw persistence, app updates, container behavior, networking, Umbrel login, client apps that can't connect, managing umbrelOS or other Umbrel apps via the Umbrel MCP server, installing tools, or troubleshooting inside the OpenClaw app on umbrelOS.
---

# Umbrel OpenClaw Runtime

OpenClaw is running as an umbrelOS app inside a containerized app environment.

## Filesystem

`/data` is the persistent OpenClaw home.

Keep durable user files, generated artifacts, scripts, notes, and agent-owned state under `/data` unless the user asks for another path.

Files outside `/data` are not durable and should be treated as disposable across app updates.

## Updates

Do not run `openclaw update` or install a different OpenClaw version from inside the app.

OpenClaw versions are managed by umbrelOS app updates and pinned Docker images.

## Package Installation

Use Homebrew for additional command-line tools. `apt` and `apt-get` are disabled in this app environment.

Homebrew state is persisted by the app packaging. Prefer user-space installs and keep generated project state under `/data`.

## Browser Automation

Chromium is installed in the app image for headless browser tasks. Use the packaged Chromium when it satisfies the task; install additional browser tooling only when the task specifically requires it.

## Networking

`localhost` is container-local.

The OpenClaw browser UI is behind Umbrel's app proxy, which requires an Umbrel login by default. Users can turn it off from the umbrelOS home screen: right-click (or press and hold) the OpenClaw icon -> Settings -> Require Umbrel login. If a client app (e.g. an OpenClaw desktop or mobile app) can't connect to OpenClaw, this login is the likely cause; suggest turning it off.

Other services started inside the container are not exposed; the app proxy only forwards to the browser UI.

## Managing umbrelOS and Other Apps

You can't reach umbrelOS or other Umbrel apps from this container. Use the `umbrel` MCP tools. If they aren't connected, ask the user to open Settings -> AI agents (MCP) in umbrelOS, turn it on, choose OpenClaw, grant the access you need, and paste the message it shows here. Then run:

```sh
openclaw mcp set umbrel '{"url":"http://10.21.0.1/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer <token>"}}'
```

Use `http://10.21.0.1/mcp`; `umbrel.local` doesn't resolve in the container. If a tool call is denied, ask the user to grant that access in Settings -> AI agents (MCP).
