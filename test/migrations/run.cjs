const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "../..");
const current = fs.readFileSync(path.join(repo, "Dockerfile"), "utf8").match(/npm install -g openclaw@([^\s\\]+)/)?.[1];
const target = process.env.OPENCLAW_MIGRATION_TARGET || current;
if (!/^\d{4}\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(target || "")) throw new Error("An exact OpenClaw target version is required.");
const tag = `openclaw-umbrel-migration-test:${target}`;
const name = `openclaw-migration-test-${randomUUID()}`;
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-migration-results-"));
// Only synthetic test outputs are mounted. The container's node UID can differ
// from the runner UID, so make this new, dedicated results directory writable.
fs.chmodSync(reportDir, 0o777);
let started = false;
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
  started = true;
  try {
    code = docker(["run", "--rm", "--init", "--name", name, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", `${reportDir}:/results`, ...(process.env.MIGRATION_CASES ? ["-e", `MIGRATION_CASES=${process.env.MIGRATION_CASES}`] : []), tag]);
  } finally { cleanup(); }
}
console.log(`Migration evidence retained at ${reportDir}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `report-dir=${reportDir}\n`);
process.exitCode = code;
