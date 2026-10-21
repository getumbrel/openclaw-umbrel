// Runs inside the historical, digest-pinned App Store image using its own Node
// and dependencies. It never starts a channel or connects to a model provider.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHome, addLegacy, addHistoryAndCredentials } = require("./fixtures.cjs");
const [appVersion, expected, image] = process.argv.slice(2);
const root = "/usr/local/lib/node_modules/openclaw";
const actual = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
assert.equal(actual, expected, "the public image must contain the expected upstream release");
const state = createHome("/data");
const file = path.join(state, "openclaw.json"), config = JSON.parse(fs.readFileSync(file));
config.agents = { defaults: { workspace: path.join(state, "workspace") } };
fs.writeFileSync(file, JSON.stringify(config));
addLegacy(state, "cron");
addLegacy(state, "voicewake");
addHistoryAndCredentials(state);
const result = spawnSync(process.execPath, [path.join(root, "openclaw.mjs"), "doctor", "--repair", "--yes", "--non-interactive"], {
  stdio: "inherit", timeout: 180_000,
  env: { ...process.env, HOME: "/data", OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: file, NODE_COMPILE_CACHE: "/tmp/source-compile", OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SERVICE_REPAIR_POLICY: "external", OPENCLAW_SUPERVISOR_MODE: "external" },
});
if (result.error) throw result.error;
assert.equal(result.status, 0, "historical image Doctor must finish successfully");
fs.writeFileSync(`/results/source-${appVersion}.json`, JSON.stringify({
  appVersion, package: actual, image, node: process.version, architecture: process.arch,
  preparation: "historical JSON fixtures processed by the Doctor in the exact published App Store image, with networking disabled",
}, null, 2) + "\n");
