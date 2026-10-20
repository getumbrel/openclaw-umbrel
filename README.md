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

The Doctor matrix records expected refusals as well as working migration paths;
passing that matrix alone does not establish release readiness.
Upstream's [migration retention policy](https://github.com/openclaw/openclaw/blob/v2026.10.5/docs/gateway/doctor/config-migrations.md#retention-policy)
and [intermediate-release guidance](https://github.com/openclaw/openclaw/blob/v2026.10.5/docs/install/updating.md#upgrading-very-old-versions)
explain why a version bump alone is insufficient.

### Automatic startup upgrade

The wrapper blocks onboarding, configuration writes and Gateway startup while
the upgrade worker runs. A kernel lock serializes workers. Before any migration,
it snapshots the complete persistent home, including SQLite WAL/SHM files,
credentials, encryption keys outside `.openclaw`, custom workspaces and Homebrew.
It verifies file hashes, ownership, modes and symlink targets and fsyncs the
snapshot and journal. It requires room for the snapshot and a recovery copy,
plus 256 MiB. Paths outside the persistent home, special files and ownership
that cannot be preserved cause a safe refusal.

The image pins Doctor bridges `2026.9.5` and `2026.9.7` beside the candidate.
Each bridge is admitted only when **all** discovered core and agent databases
fit its declared schema limits. Older configuration can be transformed without
opening those databases. Legacy OAuth JSON is repaired using upstream's bridge
in a separate home containing only credential files and keys; the old package
never receives the current databases. Original encrypted sidecars are retained.
Maintenance and its descendants cannot create network sockets, and package
downloads are deferred using upstream's update handoff. Normal CLI calls use
the image's pinned OpenClaw, including when persistent npm storage has an older
copy installed.

Before activation, the worker checks credentials and saved environment values,
rejects unsettled legacy data, refreshes the candidate plugin registry, checks
SQLite integrity and requires upstream's isolated Gateway canary to reach real
readiness. A failed check restores the verified original. If a command was
interrupted or descendant shutdown is uncertain, the wrapper first restarts
the container, then restores before any Gateway starts. Recovery leaves the app
paused with an authenticated retry action. A committed receipt prevents repeat
migration on ordinary restarts. Data written after activation is never rolled
back automatically.

Backups and private diagnostics remain under `/data/.umbrel-upgrades/<id>`;
the active journal is `/data/.umbrel-upgrades/journal.json`. These contain user
secrets and must not be published. Backups are retained rather than pruned
automatically; available space is checked before each new transaction. Recovery
keeps directory inodes so the second Homebrew bind mount remains usable.

Run `npm run test:upgrades` for fault-injection tests, real-package upgrade
fixtures and the full production image. The container tests cover initial
upgrade, forced termination after SQLite changes, restoration, explicit retry,
ordinary restart, fresh setup and Gateway authentication. Tests use synthetic
credentials and isolated Docker networks; they do not prove live provider
replies, channel delivery or encrypted Matrix room recovery. CI runs both
evidence suites on native amd64 and arm64.

**Release remains held for unsupported retained layouts.** In particular,
upstream's [current Matrix migration guide](https://github.com/openclaw/openclaw/blob/v2026.10.5/docs/channels/matrix-migration.md)
requires a 2026.6 bridge and a Gateway start for the original flat layout,
followed by 2026.9.5 Doctor and a Matrix channel start. Retired account-scoped
Matrix JSON sidecars also need 2026.9.5 Doctor and a Matrix start. The wrapper
refuses both layouts before touching data, including disabled accounts; a
Gateway canary with channels disabled cannot validate these imports or room-key
recovery. Retired channel/plugin data needing 9.5 beside newer
databases, retired Workboard data already on schema 20, and unresolved canonical
OAuth references also stop safely rather than running an incompatible runtime.
These refusals protect data; they do not satisfy a universal automatic upgrade.
Keep the app update and wrapper PR in draft until the supported upgrade range
and these remaining migration paths have been resolved and validated.

## License

MIT
