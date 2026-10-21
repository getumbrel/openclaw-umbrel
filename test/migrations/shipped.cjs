const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const history = require("./shipped-history.json");

const repo = path.resolve(__dirname, "../..");
const target = fs.readFileSync(path.join(repo, "Dockerfile"), "utf8").match(/npm install -g openclaw@([^\s\\]+)/)[1];
// First release, old JSON formats, the last June release, both shipped July
// images, and every September package. App/image and upstream versions differ:
// the first July image contains 7.1, while the second contains upstream 7.1-2.
const boundaries = ["2026.2.1", "2026.4.1", "2026.6.11", "2026.7.1-1", "2026.7.1-2", "2026.9.2", "2026.9.4", "2026.9.8"];
const versions = process.env.SHIPPED_VERSIONS?.split(",") || boundaries;
if (!versions.length || new Set(versions).size !== versions.length || versions.some(version => !boundaries.includes(version))) throw new Error("Select distinct versions from the shipped boundary matrix");
const image = `openclaw-umbrel-migration-test:${target}`;
const results = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shipped-results-"));
fs.chmodSync(results, 0o777);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `report-dir=${results}\n`);
let active, volume, pulledImage;
function cleanup() {
  if (active) spawnSync("docker", ["rm", "-f", active], { stdio: "ignore" });
  if (volume) spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
  // Remove only images pulled by this run; never remove a pre-existing image.
  if (pulledImage) spawnSync("docker", ["image", "rm", pulledImage], { stdio: "ignore" });
  active = undefined;
  volume = undefined;
  pulledImage = undefined;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { cleanup(); process.exit(1); });
function docker(args, options = {}) {
  const result = spawnSync("docker", args, { cwd: repo, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed with exit ${result.status}`);
  return result.stdout;
}
const cases = [];
try {
  docker(["build", "--build-arg", `OPENCLAW_TARGET_VERSION=${target}`, "-f", "test/migrations/Dockerfile", "-t", image, "."]);
  for (const version of versions) {
    console.log(`Preparing and upgrading shipped OpenClaw ${version}`);
    active = `openclaw-shipped-${randomUUID()}`;
    try {
      const release = history.releases.find(release => release.appVersion === version);
      if (!release?.image.includes("@sha256:") || !release.upstreamVersion) throw new Error("A public image digest and expected upstream version are required");
      if (spawnSync("docker", ["image", "inspect", release.image], { stdio: "ignore" }).status !== 0) {
        pulledImage = release.image;
        docker(["pull", release.image], { timeout: 600_000 });
      }
      volume = `${active}-data`;
      docker(["volume", "create", volume]);
      docker(["run", "--rm", "--name", active, "--network", "none", "--user", "0:0", "-v", `${volume}:/data`, "--entrypoint", "chown", image, "1000:1000", "/data"]);
      const common = ["run", "--rm", "--init", "--name", active, "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", `${volume}:/data`, "-v", `${results}:/results`];
      const fd = fs.openSync(path.join(results, `source-${version}.log`), "w", 0o644);
      try {
        docker([...common, "-v", `${path.join(repo, "test/migrations")}:/tests:ro`, "--entrypoint", "node", release.image, "/tests/prepare-shipped.cjs", version, release.upstreamVersion, release.image], { stdio: ["ignore", fd, fd], timeout: 300_000 });
      } finally { fs.closeSync(fd); }
      // The stopped historical container has released all database handles. Its
      // volume keeps /data paths, ownership and permissions unchanged on upgrade.
      docker([...common, "-e", "SHIPPED_PREPARED_HOME=/data", image, "node", "/tests/upgrade-case.cjs", `shipped-${version}`]);
      const evidence = JSON.parse(fs.readFileSync(path.join(results, `upgrade-shipped-${version}`, "result.json")));
      if (!evidence.passed || evidence.source?.appVersion !== version || evidence.source.package !== release.upstreamVersion) throw new Error("Missing successful source-package evidence");
      if (evidence.source.image !== release.image || evidence.source.architecture !== process.arch) throw new Error("Source image or native architecture does not match the public release");
      cases.push({ ...evidence, publicRelease: release });
    } finally { cleanup(); }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  cleanup();
  fs.writeFileSync(path.join(results, "shipped-matrix.json"), JSON.stringify({
    target, architecture: process.arch, historyCommit: history.auditedThrough,
    passed: !process.exitCode && cases.length === versions.length,
    completeBoundaryMatrix: boundaries.every(version => cases.some(result => result.source.appVersion === version)),
    requestedVersions: versions, cases,
    scope: "Core config, cron, Voice Wake, API credentials, conversation messages and workspace preservation after the actual published image's Doctor; current production upgrader, canary, backup and restart checks",
    notExercised: ["all optional channel/plugin state", "live provider or channel traffic"],
  }, null, 2) + "\n");
  console.log(`Shipped-version evidence retained at ${results}`);
}
