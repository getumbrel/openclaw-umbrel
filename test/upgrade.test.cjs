const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { ensureUpgrade, schemaInventory } = require("../upgrade.cjs");
const { inventory, sameInventory, DIRECTORY } = require("../upgrade-storage.cjs");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "umbrel-upgrade-flow-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
for (const [version, state, agent] of [["2026.9.5", 17, 21], ["2026.9.7", 19, 24], ["2026.10.5", 20, 25]]) {
  fs.mkdirSync(path.join(root, version));
  fs.writeFileSync(path.join(root, version, "package.json"), JSON.stringify({ version, openclaw: { schemaVersions: { state, agent } } }));
  // The production parser comes from the pinned package. These fault-injection
  // tests use valid JSON and keep their miniature fake package self-contained.
  fs.mkdirSync(path.join(root, version, "node_modules/json5"), { recursive: true });
  fs.writeFileSync(path.join(root, version, "node_modules/json5/index.js"), "module.exports = JSON;");
}
function writeSchema(state, version) {
  const file = path.join(state, "state/openclaw.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS retained(value TEXT); PRAGMA user_version=${version}`);
  if (!db.prepare("SELECT * FROM retained").get()) db.prepare("INSERT INTO retained VALUES (?)").run("original record");
  db.close();
}
function fixture(name, version = 19) {
  const home = path.join(root, name), stateDir = path.join(home, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({ heartbeat: { every: "37m" } }));
  fs.writeFileSync(path.join(stateDir, ".env"), "SYNTHETIC_KEY=retain-this\n", { mode: 0o600 });
  writeSchema(stateDir, version);
  const calls = [];
  const options = {
    home, stateDir, targetRoot: path.join(root, "2026.10.5"), bridgeRoot: v => path.join(root, v),
    containerIdentity: () => "first-container",
    async run(args) {
      calls.push(args);
      if (args[1] === "needs-config") fs.writeFileSync(args[3], '{"required":true}');
      if (args[1] === "config") fs.writeFileSync(args[3], JSON.stringify({ changed: true, config: { agents: { defaults: { heartbeat: { every: "37m" } } } } }));
      if (args[1] === "doctor") writeSchema(stateDir, path.basename(path.dirname(args[0])) === "2026.10.5" ? 20 : 19);
    },
  };
  return { home, stateDir, options, calls, before: inventory(home) };
}
test("newer databases bypass incompatible old Doctors while configuration can migrate separately", async () => {
  const f = fixture("route");
  await ensureUpgrade(f.options);
  assert.deepEqual(f.calls.filter(args => args[1] === "doctor").map(args => path.basename(path.dirname(args[0]))), ["2026.9.7", "2026.10.5"]);
  assert.equal(schemaInventory(f.stateDir).state, 20);
  const count = f.calls.length;
  await ensureUpgrade(f.options);
  assert.equal(f.calls.length, count, "an ordinary restart does not run migrations again");
});
test("a failed validation restores original database schema, configuration and credential bytes", async () => {
  const f = fixture("failed-validation");
  const run = f.options.run;
  await assert.rejects(ensureUpgrade({ ...f.options, async run(args, opts) {
    await run(args, opts);
    if (args[1] === "canary") throw new Error("readiness failed");
  } }), /readiness failed/);
  sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), f.before);
  await assert.rejects(ensureUpgrade(f.options), /retry is required/);
  await ensureUpgrade({ ...f.options, retry: true });
});
test("interruption cannot restore over a possibly live helper; the next container restores before any command", async () => {
  const f = fixture("interrupted");
  await assert.rejects(ensureUpgrade({ ...f.options, async checkpoint(phase) {
    if (phase === "validating") throw Object.assign(new Error("simulated power loss"), { interrupted: true });
  } }), /power loss/);
  assert.equal(schemaInventory(f.stateDir).state, 20);
  await assert.rejects(ensureUpgrade(f.options), /Container restart is required/);
  const count = f.calls.length;
  await assert.rejects(ensureUpgrade({ ...f.options, containerIdentity: () => "next-container" }), /rolled back/);
  assert.equal(f.calls.length, count);
  sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), f.before);
});
test("a newer-than-target database is refused without running any migration", async () => {
  const f = fixture("downgrade", 21);
  await assert.rejects(ensureUpgrade(f.options), /runtime downgrade/);
  assert.equal(f.calls.length, 0);
  sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), f.before);
});
test("retired data needing the oldest bridge is retained when its database is too new", async () => {
  const f = fixture("old-data");
  fs.mkdirSync(path.join(f.stateDir, "telegram"));
  fs.writeFileSync(path.join(f.stateDir, "telegram/bot-info.json"), '{"retained":true}');
  const before = inventory(f.home);
  await assert.rejects(ensureUpgrade(f.options), /database-compatible importer/);
  assert.equal(f.calls.length, 0);
  sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), before);
});
test("a state symlink outside the snapshot boundary is refused before commands or snapshots", async () => {
  const f = fixture("outside-link");
  fs.symlinkSync(root, path.join(f.stateDir, "external"));
  await assert.rejects(ensureUpgrade(f.options), /outside the recoverable/);
  assert.equal(f.calls.length, 0);
});
test("an external custom workspace is refused before maintenance can write outside the snapshot", async () => {
  const f = fixture("external-workspace");
  fs.writeFileSync(path.join(f.stateDir, "openclaw.json"), JSON.stringify({ agents: { defaults: { workspace: root } } }));
  await assert.rejects(ensureUpgrade(f.options), /Configured data path is outside/);
  assert.equal(f.calls.length, 0);
});
test("custom agent databases also prevent incompatible bridge runtimes from starting", async () => {
  const f = fixture("custom-agent");
  const directory = path.join(f.home, "custom-agent");
  fs.mkdirSync(directory);
  const db = new DatabaseSync(path.join(directory, "openclaw-agent.sqlite"));
  db.exec("CREATE TABLE session_nodes(value TEXT); PRAGMA user_version=25");
  db.close();
  fs.writeFileSync(path.join(f.stateDir, "openclaw.json"), JSON.stringify({ agents: { entries: { custom: { agentDir: directory } } } }));
  await ensureUpgrade(f.options);
  assert.deepEqual(f.calls.filter(args => args[1] === "doctor").map(args => path.basename(path.dirname(args[0]))), ["2026.10.5"]);
});
test("original Matrix crypto layout pauses before snapshots or any runtime can touch it", async () => {
  const f = fixture("matrix-flat");
  fs.mkdirSync(path.join(f.stateDir, "matrix/crypto"), { recursive: true });
  fs.writeFileSync(path.join(f.stateDir, "matrix/crypto/retained-room-keys"), "synthetic encrypted history");
  const before = inventory(f.home);
  await assert.rejects(ensureUpgrade(f.options), /2026.6 migration/);
  assert.equal(f.calls.length, 0);
  sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), before);
});
test("retired Matrix account sidecars stop before snapshots even when the channel is disabled", async () => {
  for (const name of ["thread-bindings.json", "startup-verification.json", "recovery-key.json", "legacy-crypto-migration.json", "crypto-idb-snapshot.json", "storage-meta.json", "inbound-dedupe.json"]) {
    const f = fixture(`matrix-${name}`);
    const directory = path.join(f.stateDir, "matrix/accounts/disabled/token-hash");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, name), '{"synthetic":"retained"}');
    const before = inventory(f.home);
    await assert.rejects(ensureUpgrade(f.options), /2026.9.5 Doctor and a Matrix channel start/);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(path.join(f.home, DIRECTORY, "journal.json")), false);
    sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), before);
  }
});
test("Matrix sidecars in an internal symlinked account are also refused", async () => {
  const f = fixture("matrix-linked");
  const directory = path.join(f.home, "retained-matrix-account");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "crypto-idb-snapshot.json"), '{"synthetic":"room keys"}');
  fs.mkdirSync(path.join(f.stateDir, "matrix"));
  fs.symlinkSync(directory, path.join(f.stateDir, "matrix/account"));
  const before = inventory(f.home);
  await assert.rejects(ensureUpgrade(f.options), /2026.9.5 Doctor and a Matrix channel start/);
  assert.equal(f.calls.length, 0);
  sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), before);
});
test("archived Matrix sidecars do not block a migrated account", async () => {
  const f = fixture("matrix-archived");
  const directory = path.join(f.stateDir, "matrix/accounts/default/token-hash");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "crypto-idb-snapshot.json.migrated"), '{"synthetic":"archived room keys"}');
  assert.equal((await ensureUpgrade(f.options)).upgraded, true);
});
test("reconciliation cannot discard a saved environment credential", async () => {
  const f = fixture("lost-env");
  await assert.rejects(ensureUpgrade({ ...f.options, reconcile: () => fs.writeFileSync(path.join(f.stateDir, ".env"), "OPENCLAW_GATEWAY_PASSWORD=replaced\n") }), /Saved environment setting did not survive/);
  sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), f.before);
});
test("data cannot use the metadata directory excluded from its own snapshot", async () => {
  const f = fixture("reserved-directory");
  fs.mkdirSync(path.join(f.home, DIRECTORY));
  fs.symlinkSync(path.join(f.home, DIRECTORY), path.join(f.stateDir, "workspace"));
  await assert.rejects(ensureUpgrade(f.options), /outside the recoverable/);
  assert.equal(f.calls.length, 0);
});
test("persisted alternate state selectors cannot be reloaded behind the backup boundary", async () => {
  const f = fixture("env-selector");
  fs.appendFileSync(path.join(f.stateDir, ".env"), `OPENCLAW_AGENT_DIR=${root}/untracked-agent\n`);
  const before = inventory(f.home);
  await assert.rejects(ensureUpgrade(f.options), /alternate state selector/);
  assert.equal(f.calls.length, 0);
  sameInventory(inventory(f.home, { exclude: [DIRECTORY] }), before);
});
