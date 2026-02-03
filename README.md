# docker-openclaw

> A Docker image for running [OpenClaw](https://openclaw.ai) on umbrelOS.

⚠️ WARNING: Running this on systems other than umbrelOS is likely very insecure. This configuration is only secure when running behind the umbrelOS app proxy.

## What is this?

This is a containerized version of OpenClaw with seamless onboarding on umbrelOS. It provides:

- A simple setup UI to configure your API keys (no interactive onboarding CLI)
- Headless browser setup and configured out of the box
- Automatic gateway token management
- Homebrew pre-installed for OpenClaw to install additional tools configured in a way that will persist between app updates
- apt/apt-get disabled with a message telling openclaw to use brew instead
- Globally installed node modules persisted between app updates
- Security features that complicate setup disabled which are not required on umbrelOS due to OpenClaw already being protected when running behind the umbrelOS app proxy

This creates a seamless one click install experience for OpenClaw on umbrelOS.

## License

MIT
