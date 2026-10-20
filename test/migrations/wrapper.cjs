// Host-side test of the actual production entrypoint, Docker restart policy,
// two mounts of the Homebrew directory, and authenticated wrapper proxy. All
// state is synthetic and the dedicated Docker network has no external route.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const repo = path.resolve(__dirname, "../..");
const image = process.env.UPGRADE_IMAGE || "openclaw-umbrel:upgrade-2026.10.5";
const reports = process.env.MIGRATION_REPORT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wrapper-results-"));
fs.mkdirSync(reports, { recursive: true }); fs.chmodSync(reports, 0o777);
const id = crypto.randomUUID();
const network = `openclaw-upgrade-${id}`, names = [], volumes = [];
const client = `openclaw-client-${id}`;
const docker = (args, options = {}) => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.error?.message || result.stderr}`);
  return result.stdout.trim();
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = (url, options = {}) => JSON.parse(docker(["exec", client, "node", "-e",
  "fetch(process.argv[1],JSON.parse(process.argv[2])).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(e=>{console.error(e.message);process.exit(1)})", url, JSON.stringify(options)]));
async function until(check, label, timeout = 360000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(500); }
  throw new Error(`Timed out: ${label}`);
}
function cleanup() {
  for (const name of names) {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    fs.writeFileSync(path.join(reports, `${name}.log`), (logs.stdout || "") + (logs.stderr || ""));
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
  for (const volume of volumes) spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { cleanup(); process.exit(1); });
async function scenario(kind) {
  const name = `openclaw-${kind}-${id}`, volume = `${name}-data`;
  volumes.push(volume); docker(["volume", "create", volume]);
  const mounts = ["-v", `${volume}:/data`, "-v", `${repo}/test/migrations:/tests:ro`, "-v", `${reports}:/results`];
  // Docker volume ownership is normally provisioned by umbrelOS.
  docker(["run", "--rm", "--network", "none", "--user", "0", ...mounts, image, "sh", "-c", "mkdir -p /data/linuxbrew && chown -R 1000:1000 /data"]);
  const env = ["-e", "HOME=/data", "-e", "OPENCLAW_STATE_DIR=/data/.openclaw", "-e", "APP_SEED=synthetic-wrapper-test", "-e", "OPENCLAW_SKIP_CHANNELS=1", "-e", "OPENCLAW_SKIP_CRON=1"];
  if (kind !== "fresh") docker(["run", "--rm", "--init", "--network", "none", ...env, ...mounts, image, "node", "/tests/wrapper-fixture.cjs", "seed"]);
  // Mount the same named volume's linuxbrew directory at its second production
  // location, using Docker's volume-subpath support.
  const brewMount = ["--mount", `type=volume,src=${volume},dst=/home/linuxbrew,volume-subpath=linuxbrew`];
  names.push(name);
  docker(["run", "-d", "--init", "--restart", "on-failure", "--stop-timeout", "60", "--name", name, "--network", network, ...env, ...mounts, ...brewMount, image]);
  const url = `http://${name}:18789`;
  const status = () => JSON.parse(docker(["exec", name, "node", "/tests/wrapper-fixture.cjs", "status"]));
  if (kind === "interrupted") {
    await until(() => { const s = status(); return s.phase === "migrating" && s.database; }, "migration has modified SQLite");
    const competing = spawnSync("docker", ["exec", name, "flock", "--nonblock", "/data/.umbrel-upgrades/process.lock", "true"], { encoding: "utf8" });
    assert.equal(competing.stderr, "");
    assert.equal(competing.status, 1, "the running worker must hold the kernel lock across maintenance commands");
    const page = request(url); assert.equal(page.status, 503);
    docker(["kill", "--signal", "KILL", name]); docker(["start", name]);
    await until(() => status().phase === "failed", "container restart restores the snapshot");
    assert.equal(status().restored, true);
    console.log(docker(["exec", name, "node", "/tests/wrapper-fixture.cjs", "restored"]));
    await until(() => request(url).body.includes("OpenClaw needs attention"), "wrapper pauses after recovery");
    const paused = request(url); assert.equal(paused.status, 503);
    const html = paused.body; assert.match(html, /OpenClaw needs attention/);
    const token = html.match(/'x-umbrel-upgrade-token':'([a-f0-9]+)'/)?.[1]; assert.ok(token);
    assert.equal(request(`${url}/api/upgrade/retry`, { method: "POST" }).status, 403);
    assert.equal(request(`${url}/api/upgrade/retry`, { method: "POST", headers: { "x-umbrel-upgrade-token": token } }).status, 202);
  }
  await until(async () => {
    try {
      const response = request(url);
      if (response.status !== 200) return false;
      const html = response.body;
      return kind === "fresh" ? html.includes("xterm") : html.includes("data-openclaw-control-ui-build-id=") && request(`${url}/readyz`).status === 200;
    } catch { return false; }
  }, `${kind} wrapper is ready`);
  if (kind === "fresh") console.log(docker(["exec", name, "node", "/tests/wrapper-fixture.cjs", "fresh"]));
  else {
    const receipt = status(); assert.equal(receipt.phase, "committed");
    const compatibility = spawnSync("docker", ["exec", "-e", `OPENCLAW_TEST_URL=${url}`, client, "node", "/app/test/gateway-compatibility.cjs"], { encoding: "utf8", timeout: 120000 });
    fs.writeFileSync(path.join(reports, `${kind}-gateway.log`), (compatibility.stdout || "") + (compatibility.stderr || ""));
    assert.equal(compatibility.status, 0, compatibility.stderr);
    docker(["restart", name]);
    await until(() => { try { return request(url).body.includes("data-openclaw-control-ui-build-id=") && request(`${url}/readyz`).status === 200; } catch { return false; } }, "ordinary restart");
    assert.equal(status().id, receipt.id, "ordinary restart must not rerun migrations");
    console.log(`PASS: ${kind} production wrapper, Gateway authentication and ordinary restart`);
  }
  docker(["stop", name]);
}
async function main() {
  console.log(`Production wrapper evidence: ${reports}`);
  docker(["network", "create", "--internal", network]);
  try {
    names.push(client);
    docker(["run", "-d", "--init", "--name", client, "--network", network, "-v", `${repo}/test:/app/test:ro`, image, "sleep", "infinity"]);
    for (const kind of (process.env.WRAPPER_CASES || "healthy,interrupted,fresh").split(",")) await scenario(kind);
    fs.writeFileSync(path.join(reports, "wrapper-result.json"), JSON.stringify({ passed: true, image, cases: process.env.WRAPPER_CASES || "healthy,interrupted,fresh" }, null, 2));
  } finally { cleanup(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
