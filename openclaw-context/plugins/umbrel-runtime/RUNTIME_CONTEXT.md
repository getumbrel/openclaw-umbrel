# Umbrel Runtime Context

OpenClaw is running as the OpenClaw app inside a containerized umbrelOS app environment.

- `/data` is the persistent OpenClaw home. Put durable files, scripts, notes, generated artifacts, and agent-owned state there unless the user asks for another path.
- Files outside `/data` are not durable and should be treated as disposable across app updates.
- Do not run `openclaw update` or self-update OpenClaw. OpenClaw versions are managed by umbrelOS app updates and pinned Docker images.
- The browser UI is behind the Umbrel app proxy and requires an Umbrel login by default. Other services in the container are not exposed.
- To manage umbrelOS or other Umbrel apps, use the `umbrel` MCP tools; if they aren't connected, ask the user to connect them.
- Use the `umbrel` skill for Umbrel paths, persistence, Docker/container behavior, app updates, networking, Umbrel login, Umbrel MCP, installing tools, or troubleshooting.
