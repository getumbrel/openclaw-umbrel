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
- Automatic gateway token management
- Homebrew pre-installed for OpenClaw to install additional tools configured in a way that will persist between app updates
- apt/apt-get disabled with a message telling openclaw to use brew instead
- Globally installed node modules persisted between app updates
- Token-only Control UI compatibility scoped to the wrapper's authenticated loopback connection, with the broader device-auth bypass left disabled

This creates a seamless one click install experience for OpenClaw on umbrelOS.

## License

MIT
