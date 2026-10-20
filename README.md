<div align=center><a href="https://apps.umbrel.com/app/openclaw"><img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/openclaw.png" alt="OpenClaw" height="60"></a></div>

# OpenClaw for umbrelOS

> A Docker image for running [OpenClaw](https://openclaw.ai) on umbrelOS.

⚠️ WARNING: Running this on systems other than umbrelOS is likely very insecure. This configuration is only secure when running behind the umbrelOS app proxy.

<a href="https://apps.umbrel.com/app/openclaw"><img src="https://apps.umbrel.com/badge-dark.svg" alt="badge-dark" height="60"></a>

## What is this?

This is a containerized version of OpenClaw with seamless onboarding on umbrelOS. It provides:

- A simple browser-based setup UI for configuring providers and API keys
- Headless browser setup and configured out of the box
- Sandboxing so OpenClaw runs in its own environment and cannot interfere with other Umbrel apps
- Automatic credential management for internal Gateway clients
- Homebrew pre-installed for OpenClaw to install additional tools configured in a way that will persist between app updates
- apt/apt-get disabled with a message telling openclaw to use brew instead
- Globally installed node modules persisted between app updates
- One-click Control UI access through Umbrel's authenticated proxy, with same-origin browser checks and automatic browser device enrollment
- Container-owned Gateway supervision and updates, with OpenClaw self-updates disabled

This creates a seamless one click install experience for OpenClaw on umbrelOS.

## Wrapper authentication

The Gateway listens on `127.0.0.1:18790`. The wrapper accepts app traffic on
`18789` after Umbrel authentication and identifies it to OpenClaw as the Umbrel
owner. It replaces incoming identity and forwarding headers and checks browser
Origin against the original Host and protocol before forwarding HTTP or WebSocket
requests. Umbrel's proxy must preserve Host and set `X-Forwarded-Proto` when
terminating TLS.

On upgrade, the wrapper removes the retired device-auth flags and shared Gateway
token, enables trusted-proxy browser authentication, and provisions a persistent
password for direct internal CLI/RPC clients. Browser device enrollment grants
ordinary UI scopes; admin access is granted to the verified Umbrel identity on
each connection. Gateway proxy requests from loopback are rejected because they
cannot provide a non-loopback proxy peer; internal clients should use OpenClaw's
CLI or the internal Gateway port with its password.

## Tests

Run `npm ci` and `npm test` for config migration, environment, proxy-boundary,
and onboarding completion tests. The image-shipped plugin test also runs when
testing inside the wrapper image, where `/app/openclaw-context` is available.

For integration checks, start a disposable configured wrapper using the current
source, then run `OPENCLAW_TEST_URL=http://127.0.0.1:<port> npm run test:integration`.
These checks enroll a test browser device and verify dashboard/bootstrap access,
device-less and signed-device handshakes, admin RPC access, stale credentials,
and cross-origin request rejection. They do not call an AI provider.

### Migration compatibility lab

Run `npm run test:migrations` with Docker available to test the OpenClaw version
pinned in the production Dockerfile. To investigate another exact release:

```sh
OPENCLAW_MIGRATION_TARGET=2026.10.5 npm run test:migrations
```

The lab builds a separate image containing the candidate and pinned `2026.9.5`,
`2026.9.7`, and `2026.9.8` packages. It runs the real Doctor CLI with networking
disabled against disposable synthetic homes. It never mounts app data or uses
real credentials. The command prints the location of `matrix.json`, per-step
logs, and copies of failed fixtures. The image is retained for subsequent runs;
the test container is removed. Set `MIGRATION_CASES` to a comma-separated list
of case IDs from `test/migrations/matrix.cjs` to repeat a specific case.

Coverage includes legacy cron JSON, Voice Wake settings, retired configuration,
Workboard cards/boards/subscriptions/attachment bytes, conversation messages,
saved provider credentials, and workspace files. Tests also cover retained
legacy data beside a `2026.9.8` database, interruption after a cron import commits,
idempotent retries, and restoring a matching old runtime after a full snapshot
that includes committed SQLite WAL data. Verification reads persisted records
and checks database integrity; a successful Doctor exit alone is insufficient.

This is the first migration implementation milestone. It does **not** enable an
automatic production migration or approve the held app update. The matrix
records expected refusals as well as working migration paths; passing the test
suite does not mean every upgrade path works. In particular, a `2026.9.8`
database containing configuration that requires `2026.9.5` still needs a
compatible importer. The older Doctor cannot open that database safely.

Before enabling the wrapper's startup migration, extend the fixtures to cover
channel/plugin-specific state (including Matrix), queued messages and media,
multiple agents and custom workspace paths, and storage/permission failures.
Add and verify the production preflight, backup, migration journal, and recovery
flow before the new Gateway or configuration reconciliation can touch old state.
The CI workflow runs this evidence suite on native amd64 and arm64 runners.
Upstream's [migration retention policy](https://github.com/openclaw/openclaw/blob/v2026.10.5/docs/gateway/doctor/config-migrations.md#retention-policy)
and [intermediate-release guidance](https://github.com/openclaw/openclaw/blob/v2026.10.5/docs/install/updating.md#upgrading-very-old-versions)
explain why a version bump alone is insufficient.

## License

MIT
