const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../..");
const production = process.argv.includes("--production");
const upgradeCases = ["legacy", "mixed-config", "workboard", "multiagent", "queued-media", "oauth-legacy", "oauth-schema20", "oauth-env-key", "oauth-missing-key", "oauth-tampered", "oauth-sqlite-shipped", "oauth-sqlite-reference", "oauth-sqlite-missing-key", "oauth-sqlite-multiagent", "workboard-schema20", "matrix-retained-9.8", "telegram-retained-9.8", "telegram-conflict-9.8"];
const current = fs.readFileSync(path.join(repo, "Dockerfile"), "utf8").match(/npm install -g openclaw@([^\s\\]+)/)?.[1];
const target = process.env.OPENCLAW_MIGRATION_TARGET || current;
if (production && target !== current) throw new Error("Production verification must use the exact version pinned in Dockerfile");
if (!/^\d{4}\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(target || "")) throw new Error("An exact OpenClaw target version is required.");
const tag = `openclaw-umbrel-migration-test:${target}`;
const name = `openclaw-migration-test-${randomUUID()}`;
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-migration-results-"));
// Only synthetic test outputs are mounted. The container's node UID can differ
// from the runner UID, so make this new, dedicated results directory writable.
fs.chmodSync(reportDir, 0o777);
let started = false;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `report-dir=${reportDir}\n`);
function cleanup() {
  if (started) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  started = false;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup(); process.exit(1); });
function docker(args) {
  const result = spawnSync("docker", args, { cwd: repo, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

console.log(`Testing OpenClaw ${target}; reports: ${reportDir}`);
let code = docker(["build", "--build-arg", `OPENCLAW_TARGET_VERSION=${target}`, "-f", "test/migrations/Dockerfile", "-t", tag, "."]);
if (code === 0) {
  // Do not let another local build change the runtime between fixture cases.
  const inspected = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", tag], { encoding: "utf8" });
  if (inspected.status !== 0) throw new Error("Cannot identify the built test image");
  const testImage = inspected.stdout.trim();
  started = true;
  try {
    const base = ["run", "--rm", "--init", "--name", name, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", `${reportDir}:/results`];
    if (production) {
      code = docker([...base, testImage, "npm", "--prefix", "/app", "test"]);
      for (const id of upgradeCases) {
        if (code !== 0) break;
        code = docker([...base, testImage, "node", "/tests/upgrade-case.cjs", id]);
      }
    } else code = docker([...base, ...(process.env.MIGRATION_CASES ? ["-e", `MIGRATION_CASES=${process.env.MIGRATION_CASES}`] : []), testImage]);
  } finally { cleanup(); }
}
if (production && code === 0) {
  const image = `openclaw-umbrel:upgrade-${target}`;
  code = docker(["build", "-t", image, "."]);
  if (code === 0) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "wrapper.cjs")], {
      cwd: repo, stdio: "inherit", env: { ...process.env, UPGRADE_IMAGE: image, MIGRATION_REPORT_DIR: reportDir },
    });
    if (result.error) throw result.error;
    code = result.status ?? 1;
  }
}
if (production) {
  const cases = fs.readdirSync(reportDir).filter(name => name.startsWith("upgrade-")).flatMap(name => {
    const file = path.join(reportDir, name, "result.json");
    return fs.existsSync(file) ? [JSON.parse(fs.readFileSync(file, "utf8"))] : [];
  });
  fs.writeFileSync(path.join(reportDir, "upgrade-matrix.json"), JSON.stringify({
    target, architecture: process.arch, passed: code === 0 && cases.length === upgradeCases.length, cases,
    productionReady: false,
    publicHistory: { commit: require("./shipped-history.json").auditedThrough, latest: "2026.9.8", latestStateSchema: 19 },
    recoveryOnlyCases: ["oauth-schema20", "oauth-sqlite-reference", "workboard-schema20"],
    releaseBlockers: ["Original and retired account-scoped Matrix layouts remain possible from public releases and require a verified channel migration", "Other retired channel/plugin formats need provenance and preservation checks; Telegram offset import is covered separately", "Representative provider/channel operation and encrypted Matrix recovery remain unverified"],
    scopeNotes: ["Schema-20 recovery scenarios are not ordinary starting states produced by public releases", "Synthetic retained-layout fixtures establish behavior and possible routes, not affected-user counts"],
  }, null, 2));
}
console.log(`Migration evidence retained at ${reportDir}`);
process.exitCode = code;
