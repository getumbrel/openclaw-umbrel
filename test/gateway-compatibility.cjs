// Run against a disposable, configured wrapper. This enrolls a test browser
// device and checks both HTTP browser auth and secure-context device pairing.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const WebSocket = require("ws");

const base = process.env.OPENCLAW_TEST_URL;
if (!base) throw new Error("Set OPENCLAW_TEST_URL to a disposable configured wrapper URL.");
const origin = new URL(base).origin;
const wsUrl = origin.replace(/^http/, "ws");
const keys = crypto.generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const deviceId = crypto.createHash("sha256").update(publicKey).digest("hex");

async function connect(buildId, { device = false, token, requestOrigin = origin, headers = {}, forbidden = false } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { origin: requestOrigin, headers });
    let hello;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.terminate();
      error ? reject(error) : resolve(hello);
    };
    const timer = setTimeout(() => finish(new Error("Gateway handshake/health timed out")), 15000);
    ws.on("error", finish);
    ws.on("close", () => {
      if (!settled) finish(new Error("Gateway closed before completing handshake/health"));
    });
    ws.on("unexpected-response", (_req, response) => {
      response.resume();
      try {
        assert.equal(forbidden, true, "Unexpected HTTP rejection");
        assert.equal(response.statusCode, 403);
        finish();
      } catch (error) { finish(error); }
    });
    ws.on("message", (data) => {
      try {
        const frame = JSON.parse(data);
        if (frame.event === "connect.challenge") {
          assert.equal(forbidden, false, "Cross-origin WebSocket reached the Gateway");
          const params = {
            minProtocol: 4, maxProtocol: 4,
            client: { id: "openclaw-control-ui", version: "compatibility-test", buildId, platform: "web", mode: "webchat" },
            role: "operator",
            scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing", "operator.questions"],
            ...(token ? { auth: { token } } : {}),
          };
          if (device) {
            const signedAt = Date.now();
            const nonce = frame.payload.nonce;
            const payload = ["v3", deviceId, params.client.id, params.client.mode, params.role,
              params.scopes.join(","), String(signedAt), token || "", nonce, params.client.platform, ""].join("|");
            params.device = { id: deviceId, publicKey: publicKey.toString("base64url"), signedAt, nonce,
              signature: crypto.sign(null, Buffer.from(payload), keys.privateKey).toString("base64url") };
          }
          ws.send(JSON.stringify({ type: "req", id: "connect", method: "connect", params }));
        } else if (frame.id === "connect") {
          assert.equal(frame.ok, true, JSON.stringify(frame.error));
          assert.equal(frame.payload.type, "hello-ok");
          assert.ok(frame.payload.auth.scopes.includes("operator.admin"));
          hello = frame.payload;
          ws.send(JSON.stringify({ type: "req", id: "health", method: "health", params: {} }));
        } else if (frame.id === "health") {
          assert.equal(frame.ok, true, JSON.stringify(frame.error));
          assert.equal(frame.payload.ok, true);
          if (device) {
            ws.send(JSON.stringify({ type: "req", id: "devices", method: "device.pair.list", params: {} }));
          } else {
            finish();
          }
        } else if (frame.id === "devices") {
          assert.equal(frame.ok, true, JSON.stringify(frame.error));
          const paired = frame.payload.paired.find((entry) => entry.deviceId === deviceId);
          assert.ok(paired, "The new browser device should be enrolled");
          assert.ok(!(paired.approvedScopes || paired.scopes).includes("operator.admin"));
          finish();
        }
      } catch (error) { finish(error); }
    });
  });
}

async function main() {
  const page = await fetch(origin, { redirect: "manual" });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("location"), null, "The wrapper must not redirect with a token");
  const html = await page.text();
  assert.match(html, /data-openclaw-control-ui-build-id=/, "Wait for the Gateway to serve its Control UI");
  const configResponse = await fetch(`${origin}/control-ui-config.json`);
  assert.equal(configResponse.status, 200);
  const { serverBuildId: buildId } = await configResponse.json();
  assert.ok(buildId);
  console.log("PASS: dashboard and bootstrap config load without a token redirect");

  await connect(buildId);
  console.log("PASS: HTTP browser without device identity connects with admin access and can call health");
  await connect(buildId, { token: "stale-pre-upgrade-token", headers: {
    authorization: "Bearer stale-pre-upgrade-token", "x-umbrel-user": "attacker",
    "x-forwarded-for": "127.0.0.1", "tailscale-user-login": "attacker",
  } });
  console.log("PASS: stale browser credentials and spoofed identity headers do not override proxy identity");

  const paired = await connect(buildId, { device: true });
  assert.equal(paired.auth.deviceToken, undefined, "Trusted-proxy sessions must not mint a bypass credential");
  await connect(buildId, { device: true });
  console.log("PASS: signed browser device enrolls and reconnects without manual pairing");

  if (origin.startsWith("http:")) {
    await connect(buildId, { requestOrigin: origin.replace(/^http:/, "https:"), headers: { "x-forwarded-proto": "https" } });
    await connect(buildId, { headers: { "x-forwarded-proto": "https" }, forbidden: true });
    console.log("PASS: TLS proxy protocol is honored and cross-scheme browser requests are rejected");
  }

  const rejected = await fetch(origin, { method: "POST", headers: { origin: "https://evil.example" }, body: "test" });
  assert.equal(rejected.status, 403);
  await connect(buildId, { requestOrigin: "https://evil.example", forbidden: true });
  console.log("PASS: cross-origin HTTP and WebSocket requests are rejected");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
