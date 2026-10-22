// Exercise normal production startup on data prepared by recent Store images.
// No production migration helpers, real credentials or external network traffic.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const history = require("../migrations/shipped-history.json");
const repo = path.resolve(__dirname, "../..");
const versions = ["2026.9.2", "2026.9.4", "2026.9.8"];
const required = [...versions, "fresh"];
const selected = process.env.UPGRADE_CASES?.split(",") || required;
if (!selected.length || new Set(selected).size !== selected.length || selected.some(c => !required.includes(c))) throw new Error("UPGRADE_CASES must select distinct recent versions or fresh");
const target = fs.readFileSync(path.join(repo, "Dockerfile"), "utf8").match(/npm install -g openclaw@([^\s\\]+)/)[1];
const tag = `openclaw-umbrel:recent-${target}`;
const reports = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recent-upgrades-"));
fs.chmodSync(reports, 0o777);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `report-dir=${reports}\n`);
const id = randomUUID(), network = `openclaw-recent-${id}`, client = `openclaw-client-${id}`;
const names = new Set(), volumes = new Set(), pulled = new Set();
let candidate, networkCreated = false;
const report = { target, architecture: process.arch, passed: false, completeQualification: false, requiredVersions: versions, requestedCases: selected, cases: [], limitations: ["synthetic core-state fixtures", "no live provider or channel calls", "no interactive TUI onboarding", "retired formats and very old installations are outside qualification"] };
function docker(args, options = {}) {
  const temporary = args[0] === "run" && args.includes("--rm") && !args.includes("--name") ? `openclaw-check-${randomUUID()}` : undefined;
  if (temporary) { args = ["run", "--name", temporary, ...args.slice(1)]; names.add(temporary); }
  const result = spawnSync("docker", args, { cwd: repo, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (!result.error && temporary) names.delete(temporary);
  if (result.error || result.status !== 0) throw new Error(`docker ${args[0]} exited ${result.status}: ${result.error?.message || result.stderr || result.stdout || "see captured log"}`);
  return result.stdout?.trim();
}
function logged(args, file, timeout = 180000) {
  const fd = fs.openSync(path.join(reports, file), "w", 0o644);
  try { return docker(args, { stdio: ["ignore", fd, fd], timeout }); }
  catch (error) { error.message += ` (${path.join(reports, file)})`; throw error; }
  finally { fs.closeSync(fd); }
}
function capture(name, suffix = "") {
  const result = spawnSync("docker", ["logs", name], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  fs.writeFileSync(path.join(reports, `${name}${suffix}.log`), (result.stdout || "") + (result.stderr || ""));
}
function remove(name, volume) {
  if (names.has(name)) { capture(name); docker(["rm", "-f", name]); names.delete(name); }
  if (volumes.has(volume)) { docker(["volume", "rm", volume]); volumes.delete(volume); }
}
function cleanup() {
  for (const name of names) { capture(name); spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }); }
  for (const volume of volumes) spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
  if (networkCreated) spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
  for (const image of pulled) spawnSync("docker", ["image", "rm", image], { stdio: "ignore" });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup(); process.exit(1); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(url) {
  return JSON.parse(docker(["exec", client, "node", "-e", "fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(()=>console.log(JSON.stringify({status:0})))", url]));
}
async function ready(url, setup = false) {
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    const response = request(url);
    if (response.status === 200 && (setup ? response.body.includes("xterm") : response.body.includes("data-openclaw-control-ui-build-id=") && request(`${url}/readyz`).status === 200)) return;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${setup ? "setup" : "Gateway readiness"}: ${url}`);
}
const env = ["-e", "HOME=/data", "-e", "OPENCLAW_STATE_DIR=/data/.openclaw", "-e", "APP_SEED=synthetic-recent-test", "-e", "OPENCLAW_SERVICE_REPAIR_POLICY=external", "-e", "OPENCLAW_SUPERVISOR_MODE=external", "-e", "OPENCLAW_NO_RESPAWN=1", "-e", "OPENCLAW_SKIP_CHANNELS=1", "-e", "OPENCLAW_SKIP_PROVIDERS=1", "-e", "OPENCLAW_SKIP_CRON=1", "-e", "OPENCLAW_SKIP_GMAIL_WATCHER=1", "-e", "OPENCLAW_SKIP_STARTUP_MODEL_PREWARM=1"];
function initVolume(volume) {
  docker(["volume", "create", volume]); volumes.add(volume);
  docker(["run", "--rm", "--network", "none", "--user", "0", "-v", `${volume}:/data`, candidate, "sh", "-c", "mkdir -p /data/linuxbrew && chown -R 1000:1000 /data"]);
}
function mounts(volume) {
  return ["-v", `${volume}:/data`, "-v", `${repo}/test:/tests:ro`, "-v", `${reports}:/results`];
}
function start(name, volume) {
  names.add(name);
  docker(["run", "-d", "--init", "--restart", "on-failure", "--stop-timeout", "60", "--name", name, "--network", network, ...env, ...mounts(volume), "--mount", `type=volume,src=${volume},dst=/home/linuxbrew,volume-subpath=linuxbrew`, candidate]);
}
function verify(volume, fresh) {
  // Inspect persisted records only after the Gateway has released its database
  // handles. Live checks above use the public HTTP/WebSocket surfaces instead.
  return JSON.parse(docker(["run", "--rm", "--init", "--network", "none", ...env, ...mounts(volume), "--mount", `type=volume,src=${volume},dst=/home/linuxbrew,volume-subpath=linuxbrew`, candidate, "node", "/tests/upgrades/fixture.cjs", fresh ? "fresh-verify" : "verify"]));
}
async function scenario(version) {
  const fresh = version === "fresh", name = `openclaw-${version.replaceAll(".", "-")}-${id}`, volume = `${name}-data`;
  const row = { version, passed: false }; report.cases.push(row);
  initVolume(volume);
  try {
    if (fresh) {
      // OpenAI onboarding installs this upstream runtime. Install the pinned
      // real dependency before adding any credentials, then isolate onboarding
      // and Gateway traffic from external services for the rest of the test.
      logged(["run", "--rm", "--init", ...env, ...mounts(volume), candidate, "openclaw", "plugins", "install", `@openclaw/codex@${target}`], "fresh-runtime-install.log", 600000);
      row.runtimeDependency = `@openclaw/codex@${target}`;
    } else {
      const release = history.releases.find(r => r.appVersion === version);
      assert.ok(release?.image.includes("@sha256:") && release.upstreamVersion);
      if (spawnSync("docker", ["image", "inspect", release.image], { stdio: "ignore" }).status !== 0) {
        pulled.add(release.image);
        logged(["pull", release.image], `pull-${version}.log`, 600000);
      }
      logged(["run", "--rm", "--init", "--network", "none", "--user", "1000:1000", ...env, ...mounts(volume), "--entrypoint", "node", release.image, "/tests/upgrades/fixture.cjs", "seed", version, release.upstreamVersion, release.image], `source-${version}.log`, 300000);
      row.source = JSON.parse(fs.readFileSync(path.join(reports, `source-${version}.json`)));
      assert.equal(row.source.architecture, process.arch, "source runs on the native architecture");
      assert.equal(row.source.image, release.image);
    }
    start(name, volume);
    const url = `http://${name}:18789`;
    if (fresh) {
      await ready(url, true); row.setupPage = true;
      logged(["exec", name, "openclaw", "onboard", "--non-interactive", "--accept-risk", "--flow", "quickstart", "--mode", "local", "--auth-choice", "openai-api-key", "--openai-api-key", "synthetic-fresh-key-not-valid", "--gateway-port", "18790", "--gateway-bind", "loopback", "--skip-channels", "--skip-skills", "--skip-search", "--skip-daemon", "--skip-health", "--skip-hooks", "--skip-ui", "--skip-bootstrap"], "fresh-onboard.log");
      row.onboarding = true;
    }
    await ready(url);
    assert.match(docker(["exec", name, "openclaw", "--version"]), new RegExp(`OpenClaw ${target.replaceAll(".", "\\.")}(?:\\s|$)`));
    row.pinnedCli = true;
    logged(["exec", "-e", `OPENCLAW_TEST_URL=${url}`, client, "node", "/app/test/gateway-compatibility.cjs"], `${version}-gateway.log`, 120000);
    row.gatewayAuthentication = true;
    capture(name, "-before-restart");
    docker(["stop", name]);
    row.beforeRestart = verify(volume, fresh);
    docker(["start", name]); await ready(url);
    docker(["stop", name]);
    row.afterRestart = verify(volume, fresh);
    row.passed = true;
    console.log(`PASS ${version}: ${fresh ? "setup and onboarding" : "retained core data"}, Gateway authentication, restart`);
  } finally { remove(name, volume); }
}
async function main() {
  console.log(`Recent upgrade evidence: ${reports}`);
  logged(["build", "-t", tag, "."], "build.log", 1800000);
  candidate = docker(["image", "inspect", "--format", "{{.Id}}", tag]); report.image = candidate;
  docker(["network", "create", "--internal", network]); networkCreated = true;
  names.add(client);
  docker(["run", "-d", "--init", "--name", client, "--network", network, "-v", `${repo}/test:/app/test:ro`, candidate, "sleep", "infinity"]);
  logged(["run", "--rm", "--init", "--network", "none", "-v", `${repo}/test:/app/test:ro`, candidate, "npm", "--prefix", "/app", "test"], "unit-tests.log");
  report.unitTests = true;
  for (const version of selected) await scenario(version);
  logged(["run", "--rm", "--init", "--network", "none", "-e", "HOME=/tmp/refusal", "-e", "OPENCLAW_STATE_DIR=/tmp/refusal/.openclaw", "-v", `${repo}/test:/tests:ro`, candidate, "node", "/tests/upgrades/fixture.cjs", "refusal"], "retired-input.log");
  report.retiredInputPreserved = true;
  report.passed = report.cases.length === selected.length && report.cases.every(c => c.passed);
  report.completeQualification = report.passed && required.every(version => report.cases.some(c => c.version === version));
}
main().catch(error => { report.error = error.stack; console.error(error); process.exitCode = 1; }).finally(() => {
  cleanup();
  fs.writeFileSync(path.join(reports, "upgrade-matrix.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Evidence retained at ${reports}`);
});
