const assert = require("node:assert/strict");
const { test, beforeEach, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wrapper-test-"));
const configFile = path.join(stateDir, "openclaw.json");
const envFile = path.join(stateDir, ".env");
process.env.OPENCLAW_STATE_DIR = stateDir;
const { reconcileConfig, getOpenClawEnv, getGatewayProxyHeaders, isAllowedBrowserRequest } = require("../server.cjs");

beforeEach(() => {
  fs.writeFileSync(configFile, JSON.stringify({ wizard: { lastRunVersion: "2026.7.1-2" } }));
  fs.writeFileSync(envFile, "");
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
});
after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

test("migrates legacy token auth while retaining user settings and a stable internal password", () => {
  const config = {
    wizard: { lastRunVersion: "2026.7.1-2" },
    agents: { defaults: { model: { primary: "openai-codex/gpt-5" } } },
    channels: { telegram: { enabled: true, botToken: "test-channel-token" } },
    gateway: {
      mode: "remote", bind: "lan", port: 9999, trustedProxies: ["0.0.0.0/0"],
      controlUi: { allowInsecureAuth: true, dangerouslyDisableDeviceAuth: true, basePath: "/" },
      auth: { mode: "token", token: "test-old-token" },
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(envFile, "OPENCLAW_GATEWAY_TOKEN=test-old-token\nOPENAI_API_KEY=test-provider-key\n");
  process.env.OPENCLAW_GATEWAY_TOKEN = "inherited-old-token";
  process.env.OPENCLAW_GATEWAY_PASSWORD = "inherited-stale-password";
  reconcileConfig();
  const result = JSON.parse(fs.readFileSync(configFile));
  assert.deepEqual(result.agents, config.agents);
  assert.deepEqual(result.channels, config.channels);
  assert.deepEqual(result.wizard, config.wizard);
  assert.equal(result.gateway.auth.mode, "trusted-proxy");
  assert.equal(result.gateway.auth.token, undefined);
  assert.equal(result.gateway.controlUi.allowInsecureAuth, undefined);
  assert.equal(result.gateway.controlUi.dangerouslyDisableDeviceAuth, undefined);
  assert.equal(result.gateway.controlUi.basePath, "/");
  assert.ok(result.gateway.controlUi.allowedOrigins.includes("http://127.0.0.1:18790"));
  assert.deepEqual(result.gateway.trustedProxies, ["127.0.0.1/32"]);
  assert.deepEqual(result.gateway.auth.identityScopes, { "umbrel-owner": ["operator.admin"] });
  assert.equal(result.gateway.auth.trustedProxy.allowLoopback, true);
  assert.equal(result.gateway.auth.trustedProxy.deviceAutoApprove.enabled, true);
  assert.ok(!result.gateway.auth.trustedProxy.deviceAutoApprove.scopes.includes("operator.admin"));
  assert.match(result.gateway.auth.password, /^[a-f0-9]{48}$/);
  const env = getOpenClawEnv();
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(env.OPENCLAW_GATEWAY_PASSWORD, result.gateway.auth.password);
  assert.equal(env.OPENAI_API_KEY, "test-provider-key");
  assert.doesNotMatch(fs.readFileSync(envFile, "utf8"), /OPENCLAW_GATEWAY_TOKEN=/);
  const before = fs.readFileSync(configFile, "utf8");
  const beforeEnv = fs.readFileSync(envFile, "utf8");
  reconcileConfig();
  assert.equal(fs.readFileSync(configFile, "utf8"), before);
  assert.equal(fs.readFileSync(envFile, "utf8"), beforeEnv);
});

test("preserves env-backed passwords without stale overrides or losing provider credentials", () => {
  const password = { source: "env", provider: "default", id: "MY_GATEWAY_PASSWORD" };
  fs.writeFileSync(configFile, JSON.stringify({ gateway: { auth: { password } } }));
  fs.writeFileSync(envFile, "MY_GATEWAY_PASSWORD=current-password\nOPENCLAW_GATEWAY_PASSWORD=stale-password\nOPENCLAW_GATEWAY_TOKEN=old-token\n");
  reconcileConfig();
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile)).gateway.auth.password, password);
  assert.doesNotMatch(fs.readFileSync(envFile, "utf8"), /^OPENCLAW_GATEWAY_PASSWORD=/m);
  assert.equal(getOpenClawEnv().OPENCLAW_GATEWAY_PASSWORD, "current-password");
});

test("enforces supervisor environment even when the persisted environment overrides it", () => {
  fs.writeFileSync(envFile, "OPENCLAW_SUPERVISOR_MODE=native\nOPENCLAW_SERVICE_REPAIR_POLICY=auto\nOPENCLAW_NO_RESPAWN=0\nOPENCLAW_STATE_DIR=/elsewhere\nOPENCLAW_GATEWAY_TOKEN=old-token\n");
  const env = getOpenClawEnv();
  assert.equal(env.OPENCLAW_SUPERVISOR_MODE, "external");
  assert.equal(env.OPENCLAW_SERVICE_REPAIR_POLICY, "external");
  assert.equal(env.OPENCLAW_NO_RESPAWN, "1");
  assert.equal(env.OPENCLAW_STATE_DIR, stateDir);
  assert.equal(env.OPENCLAW_GATEWAY_TOKEN, undefined);
});

test("migrates a password reference to the retired token environment variable", () => {
  fs.writeFileSync(configFile, JSON.stringify({ gateway: { auth: {
    password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
  } } }));
  fs.writeFileSync(envFile, "OPENCLAW_GATEWAY_TOKEN=test-existing-password\n");
  reconcileConfig();
  assert.equal(JSON.parse(fs.readFileSync(configFile)).gateway.auth.password, "test-existing-password");
  assert.equal(getOpenClawEnv().OPENCLAW_GATEWAY_PASSWORD, "test-existing-password");
  assert.equal(getOpenClawEnv().OPENCLAW_GATEWAY_TOKEN, undefined);
});

test("opts only the managed runtime plugin into conversation hooks", {
  skip: !fs.existsSync("/app/openclaw-context/plugins/umbrel-runtime") && "run in the wrapper image to test the image-shipped plugin",
}, () => {
  fs.writeFileSync(configFile, JSON.stringify({ plugins: { entries: {
    "umbrel-runtime": { enabled: true, hooks: { timeoutMs: 1000 } },
    other: { enabled: true, hooks: { allowConversationAccess: false } },
  } } }));
  reconcileConfig();
  const entries = JSON.parse(fs.readFileSync(configFile)).plugins.entries;
  assert.deepEqual(entries["umbrel-runtime"].hooks, { timeoutMs: 1000, allowConversationAccess: true });
  assert.equal(entries.other.hooks.allowConversationAccess, false);
});

function request(headers = {}, overrides = {}) {
  return { method: "GET", headers: { host: "umbrel.local:18789", ...headers }, socket: { remoteAddress: "::ffff:172.18.0.2" }, ...overrides };
}

test("replaces spoofed identity/forwarding headers and never forwards internal credentials", () => {
  const req = request({
    origin: "https://umbrel.local:18789", authorization: "Bearer old-browser-token",
    "x-umbrel-user": "attacker", "x-forwarded-for": "127.0.0.1, 8.8.8.8",
    "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https",
    "x-forwarded-custom": "spoof", "x-real-ip": "8.8.8.8", forwarded: "for=8.8.8.8",
    "tailscale-user-login": "attacker", "tailscale-funnel-request": "?1",
    "proxy-authorization": "secret", "sec-websocket-key": "test-key",
    "x-openclaw-agent-id": "main", "content-type": "application/json",
  });
  const headers = getGatewayProxyHeaders(req);
  assert.equal(headers.host, "127.0.0.1:18790");
  assert.equal(headers.origin, "http://127.0.0.1:18790");
  assert.equal(headers["x-forwarded-for"], "172.18.0.2");
  assert.equal(headers["x-umbrel-user"], "umbrel-owner");
  assert.equal(headers["sec-websocket-key"], "test-key");
  assert.equal(headers["x-openclaw-agent-id"], "main");
  for (const key of ["authorization", "proxy-authorization", "forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-custom", "tailscale-user-login", "tailscale-funnel-request"]) {
    assert.equal(headers[key], undefined, key);
  }
  assert.equal(req.headers["x-umbrel-user"], "attacker");
});

test("rejects cross-origin browser HTTP and WebSocket attempts before asserting owner identity", () => {
  for (const origin of ["https://evil.example", "null", "http://umbrel.local:80", "http://umbrel.local:18789.evil.example", "http://user@umbrel.local:18789", "http://umbrel.local:18789/path"]) {
    const req = request({ origin, "x-forwarded-host": "evil.example" });
    assert.equal(isAllowedBrowserRequest(req), false, origin);
    assert.equal(getGatewayProxyHeaders(req), null, origin);
  }
  assert.equal(isAllowedBrowserRequest(request({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(isAllowedBrowserRequest(request({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" })), true);
  assert.equal(isAllowedBrowserRequest(request({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }, { method: "POST" })), false);
  assert.equal(isAllowedBrowserRequest(request({ origin: "http://umbrel.local:18789" })), true);
  assert.equal(isAllowedBrowserRequest(request({ origin: "https://umbrel.local:18789", "x-forwarded-proto": "https" })), true);
  assert.equal(isAllowedBrowserRequest(request({ origin: "http://umbrel.local:18789", "x-forwarded-proto": "https" })), false);
  assert.equal(isAllowedBrowserRequest(request({ origin: "https://umbrel.local:18789" })), false);
});

test("uses socket attribution and refuses invented client addresses for local wrapper calls", () => {
  for (const remoteAddress of [undefined, "unknown", "127.0.0.1", "127.0.1.1", "::ffff:127.0.0.1", "::1", "::", "0.0.0.0"]) {
    assert.equal(getGatewayProxyHeaders(request({ "x-forwarded-for": "192.0.2.1" }, { socket: { remoteAddress } })), null);
  }
  assert.equal(getGatewayProxyHeaders(request({}, { socket: { remoteAddress: "fd00::2" } }))["x-forwarded-for"], "fd00::2");
});
