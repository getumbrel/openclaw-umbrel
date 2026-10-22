// Test-only state preparation and read-only verification. All secrets are fake.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { zstdDecompressSync } = require("node:zlib");
const f = require("../migrations/fixtures.cjs");
const { schemas, readTables, database } = require("../migrations/lab.cjs");
const root = "/usr/local/lib/node_modules/openclaw";
const home = process.env.HOME;
const state = path.join(home, ".openclaw");
const operation = process.argv[2];
const oauth = { type: "oauth", provider: "openai", access: "synthetic-recent-access", refresh: "synthetic-recent-refresh", expires: 4102444800000, accountId: "recent-account", email: "recent@example.invalid" };
const brewMarker = "Retain Homebrew data across image replacement.\n";
const workspaceMarker = "Keep this user's workspace.\n";
function doctor() {
  return spawnSync(process.execPath, [path.join(root, "openclaw.mjs"), "doctor", "--repair", "--yes", "--non-interactive"], {
    encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"), NODE_COMPILE_CACHE: "/tmp/fixture-compile" },
  });
}
function verify() {
  database(state, db => {
    const jobs = db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").all(f.job.id);
    assert.equal(jobs.length, 1, "one retained automation");
    const actual = JSON.parse(jobs[0].job_json);
    for (const key of ["id", "name", "enabled", "schedule", "payload"]) assert.deepEqual(actual[key], f.job[key], `automation ${key}`);
    const voice = db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'voicewake.triggers'").get();
    assert.deepEqual(JSON.parse(voice.value_json), f.voicewake.triggers);
  });
  // Recent releases moved the canonical store from agent to shared SQLite.
  const stores = [
    ...readTables(state, "config_machine_state", db => db.prepare("SELECT value_json AS json FROM config_machine_state WHERE state_key='authProfiles.store'").all()),
    ...readTables(state, "auth_profile_store", db => db.prepare("SELECT store_json AS json FROM auth_profile_store").all()),
  ].map(row => JSON.parse(row.json).profiles || {});
  for (const [id, expected] of [["openai:migration-test", f.credential], ["openai:recent-oauth", oauth]]) {
    const retained = stores.filter(store => store[id]);
    assert.ok(retained.length, `canonical credential ${id}`);
    for (const store of retained) assert.deepEqual(store[id], expected);
  }
  const events = readTables(state, "transcript_events", db => db.prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq").all(f.sessionId));
  const messages = events.flatMap(row => {
    const event = JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString());
    return event.message?.content?.filter(c => c.type === "text").map(c => c.text) ?? [];
  });
  assert.deepEqual(messages, f.conversation);
  assert.equal(fs.readFileSync(path.join(state, "workspace/USER.md"), "utf8"), workspaceMarker);
  assert.match(fs.readFileSync(path.join(state, ".env"), "utf8"), /^OPENAI_API_KEY=synthetic-test-key-not-valid$/m);
  assert.equal(fs.readFileSync(path.join(home, "linuxbrew/retained.txt"), "utf8"), brewMarker);
  for (const db of Object.values(schemas(state))) assert.deepEqual(db.integrity, ["ok"]);
}
if (operation === "seed") {
  const [version, expected, image] = process.argv.slice(3);
  const actual = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
  assert.equal(actual, expected);
  f.createHome(home);
  const configFile = path.join(state, "openclaw.json");
  const config = JSON.parse(fs.readFileSync(configFile));
  config.agents = { defaults: { workspace: path.join(state, "workspace") } };
  fs.writeFileSync(configFile, JSON.stringify(config));
  f.addLegacy(state, "cron"); f.addLegacy(state, "voicewake"); f.addHistoryAndCredentials(state);
  const authFile = path.join(state, "agents/main/agent/auth-profiles.json");
  const auth = JSON.parse(fs.readFileSync(authFile));
  auth.profiles["openai:recent-oauth"] = oauth;
  fs.writeFileSync(authFile, JSON.stringify(auth));
  fs.mkdirSync(path.join(home, "linuxbrew"), { recursive: true });
  fs.writeFileSync(path.join(home, "linuxbrew/retained.txt"), brewMarker);
  const result = doctor();
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, "published image's Doctor must complete preparation");
  verify();
  for (const file of ["cron/jobs.json", "settings/voicewake.json"]) assert.equal(fs.existsSync(path.join(state, file)), false, "source must have completed its ordinary migrations");
  // A stale persistent npm binary must not shadow the candidate's pinned CLI.
  const stale = path.join(home, ".npm-global/bin/openclaw");
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, "#!/bin/sh\necho stale-openclaw-was-used >&2\nexit 97\n", { mode: 0o755 });
  fs.writeFileSync(`/results/source-${version}.json`, JSON.stringify({ appVersion: version, package: actual, image, architecture: process.arch, node: process.version, schemas: schemas(state) }, null, 2));
} else if (operation === "verify") {
  verify();
  assert.equal(fs.readFileSync("/home/linuxbrew/retained.txt", "utf8"), brewMarker, "second Homebrew mount remains usable");
  assert.equal(fs.existsSync(path.join(home, ".umbrel-upgrades")), false, "no custom migration journal or full-home backup");
  console.log(JSON.stringify({ passed: true, schemas: schemas(state) }));
} else if (operation === "refusal") {
  // Upstream's retired-input guard must remain effective and retain source data.
  f.createHome(home); f.addLegacy(state, "cron");
  const file = path.join(state, "cron/jobs.json"), before = fs.readFileSync(file);
  const result = doctor();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /Upgrade through OpenClaw 2026\.9\.7/);
  assert.deepEqual(fs.readFileSync(file), before);
  console.log("PASS: upstream refuses retired cron without changing its bytes");
} else if (operation === "fresh-verify") {
  assert.equal(fs.existsSync(path.join(home, ".umbrel-upgrades")), false);
  const config = JSON.parse(fs.readFileSync(path.join(state, "openclaw.json")));
  assert.ok(config.wizard);
  const retained = readTables(state, "config_machine_state", db => db.prepare("SELECT value_json FROM config_machine_state WHERE state_key='authProfiles.store'").all());
  assert.ok(retained.some(row => Object.values(JSON.parse(row.value_json).profiles || {}).some(p => p.key === "synthetic-fresh-key-not-valid")));
  for (const db of Object.values(schemas(state))) assert.deepEqual(db.integrity, ["ok"]);
  console.log(JSON.stringify({ passed: true, schemas: schemas(state) }));
} else throw new Error(`Unknown fixture operation: ${operation}`);
