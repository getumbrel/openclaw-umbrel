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
- Direct native Gateway connections over a private LAN or Tailnet, protected by the app's deterministic password and explicit device pairing
- Container-owned Gateway supervision and updates, with OpenClaw self-updates disabled

This creates a seamless one click install experience for OpenClaw on umbrelOS.

## Wrapper authentication

The Gateway listens on `127.0.0.1:18790`. The wrapper accepts app traffic on
`18789` after Umbrel authentication and identifies it to OpenClaw as the Umbrel
owner. It replaces incoming identity and forwarding headers and checks browser
Origin against the original Host and protocol before forwarding HTTP or WebSocket
requests. Umbrel's proxy must preserve Host and set `X-Forwarded-Proto` when
terminating TLS.

A separate WebSocket-only listener on `18791` is intended for native clients.
It strips proxy identity, forwarding, cookie, and HTTP authorization headers and
never grants the Umbrel owner's browser identity. Clients must authenticate with
the deterministic app password shown in Umbrel's app settings, then complete
OpenClaw device and node-capability pairing. Plain HTTP requests to this listener
receive `426 Upgrade Required`.

On upgrade, the wrapper removes the retired device-auth flags and shared Gateway
token, enables trusted-proxy browser authentication, and provisions a persistent
password for direct CLI/RPC and native clients. On Umbrel the password is rotated
to the app's deterministic password so the owner can retrieve it from app
settings. Browser device enrollment grants
ordinary UI scopes; admin access is granted to the verified Umbrel identity on
each connection. Gateway proxy requests from loopback are rejected because they
cannot provide a non-loopback proxy peer; internal clients should use OpenClaw's
CLI or the internal Gateway port with its password.

The native listener is suitable for trusted private networks such as a home LAN
or Tailnet. Do not forward it directly to the public Internet: `ws://` is
unencrypted and the Gateway is a high-authority control surface. Use a properly
authenticated TLS endpoint (`wss://`) if public-network access is required.

## Tests

Run `npm ci` and `npm test` for config migration, environment, proxy-boundary,
and onboarding completion tests. The image-shipped plugin test also runs when
testing inside the wrapper image, where `/app/openclaw-context` is available.

For integration checks, start a disposable configured wrapper using the current
source, then run `OPENCLAW_TEST_URL=http://127.0.0.1:<port> npm run test:integration`.
These checks enroll a test browser device and verify dashboard/bootstrap access,
device-less and signed-device handshakes, admin RPC access, stale credentials,
and cross-origin request rejection. They do not call an AI provider.

## License

MIT
