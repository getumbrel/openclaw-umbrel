# Umbrel Runtime Context

OpenClaw is running as the OpenClaw app inside a containerized umbrelOS app environment.

- `/data` is the persistent OpenClaw home. Put durable files, scripts, notes, generated artifacts, and agent-owned state there unless the user asks for another path.
- Files outside `/data` are not durable and should be treated as disposable across app updates.
- Do not run `openclaw update` or self-update OpenClaw. OpenClaw versions are managed by umbrelOS app updates and pinned Docker images.
- The browser UI is behind the Umbrel app proxy. Services started inside the container are not automatically reachable from umbrelOS or the public network; that exposure is controlled by the Umbrel app packaging/proxy.
- Use the `umbrel` skill for Umbrel paths, persistence, Docker/container behavior, app updates, networking, installing tools, or troubleshooting.
