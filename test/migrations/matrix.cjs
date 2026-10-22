const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { zstdDecompressSync } = require("node:zlib");
const { createHome, addLegacy, addHistoryAndCredentials, job, voicewake, sessionId, conversation, credential } = require("./fixtures.cjs");
const { packageRoot, run, doctor, success, database, hash, preserved, schemas, readTables, exportFixture } = require("./lab.cjs");

const outputDir = process.env.MIGRATION_REPORT_DIR || "/results";
fs.mkdirSync(outputDir, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbrel-migration-matrix-"));
const versions = Object.fromEntries(["2026.9.5", "2026.9.7", "2026.9.8", "target"].map(key => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(key), "package.json")));
  return [key, { version: pkg.version, schemas: pkg.openclaw.schemaVersions }];
}));
for (const version of ["2026.9.5", "2026.9.7", "2026.9.8"]) assert.equal(versions[version].version, version, "bridge package must match its pinned version");

function cronSurvives(state) {
  database(state, db => {
    const rows = db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").all(job.id);
    assert.equal(rows.length, 1, "exactly one retained automation, including after retry");
    const actual = JSON.parse(rows[0].job_json);
    for (const field of ["id", "name", "enabled", "schedule", "payload"]) assert.deepEqual(actual[field], job[field], `cron ${field}`);
  });
}
function voicewakeSurvives(state) {
  const row = database(state, db => db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'voicewake.triggers'").get());
  assert.deepEqual(JSON.parse(row.value_json), voicewake.triggers);
}
function historyAndCredentialsSurvive(state) {
  const sessions = readTables(state, "session_nodes", db => db.prepare("SELECT entry_json FROM session_nodes WHERE session_key = 'agent:main:main'").all());
  assert.equal(sessions.length, 1, "one canonical conversation");
  const events = readTables(state, "transcript_events", db => db.prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq").all(sessionId));
  const texts = events.flatMap(row => {
    const event = JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString());
    return event.message?.content?.filter(c => c.type === "text").map(c => c.text) ?? [];
  });
  assert.deepEqual(texts, conversation, "both conversation messages survive in order without duplication");
  // The shared auth store is a config_machine_state record in these releases;
  // the old per-agent auth_profile_store table is deliberately emptied.
  const auth = database(state, db => db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get());
  assert.ok(auth, "canonical shared auth store survives");
  assert.deepEqual(JSON.parse(auth.value_json).profiles["openai:migration-test"], credential, "every credential field survives, independent of JSON key order");
}
async function workboard(version, operation, ctx) {
  const result = await run([path.join(__dirname, "workboard.mjs"), packageRoot(version), operation], ctx.home, ctx.log(`workboard-${version}-${operation}`), { version });
  success(result, `Workboard ${version} ${operation}`);
  return result;
}

const cases = [
  { id: "fresh", route: ["target"], disposition: "supported", async test(c) {
    await c.doctor("target");
  } },
  { id: "legacy-cron-direct", route: ["target"], disposition: "blocked", async test(c) {
    addLegacy(c.state, "cron");
    const file = path.join(c.state, "cron/jobs.json"), before = hash(file);
    const result = await c.doctor("target", { allowFailure: true });
    assert.equal(result.code, 1);
    assert.match(result.output, /Upgrade through OpenClaw 2026\.9\.7/);
    assert.equal(hash(file), before, "refused source bytes survive");
  } },
  { id: "legacy-cron-bridge", route: ["2026.9.7", "target", "target"], disposition: "supported", async test(c) {
    addLegacy(c.state, "cron");
    await c.doctor("2026.9.7"); cronSurvives(c.state);
    await c.doctor("target"); cronSurvives(c.state);
    await c.doctor("target"); cronSurvives(c.state);
  } },
  { id: "legacy-voicewake-bridge", route: ["2026.9.7", "target"], disposition: "supported", async test(c) {
    addLegacy(c.state, "voicewake");
    await c.doctor("2026.9.7"); voicewakeSurvives(c.state);
    await c.doctor("target"); voicewakeSurvives(c.state);
  } },
  { id: "legacy-config-bridge", route: ["2026.9.5", "2026.9.7", "target"], disposition: "supported", async test(c) {
    addLegacy(c.state, "config");
    await c.doctor("2026.9.5");
    await c.doctor("2026.9.7");
    await c.doctor("target");
    const config = JSON.parse(fs.readFileSync(path.join(c.state, "openclaw.json")));
    assert.equal(config.agents.defaults.heartbeat.every, "37m");
    assert.equal(config.heartbeat, undefined);
  } },
  { id: "shipped-9.8-retained-cron", route: ["2026.9.8", "2026.9.7", "target"], disposition: "supported", async test(c) {
    await c.doctor("2026.9.8");
    addLegacy(c.state, "cron");
    await c.doctor("2026.9.7"); cronSurvives(c.state);
    await c.doctor("target"); cronSurvives(c.state);
  } },
  { id: "shipped-9.8-retained-config", route: ["2026.9.8", "2026.9.5"], disposition: "blocked", async test(c) {
    await c.doctor("2026.9.8");
    addLegacy(c.state, "config");
    const before = schemas(c.state);
    const config = path.join(c.state, "openclaw.json"), configHash = hash(config);
    const result = await c.doctor("2026.9.5", { allowFailure: true });
    assert.notEqual(result.code, 0, "old bridge must not claim success against newer databases");
    assert.match(result.output, /uses schema 19; this build supports 17/);
    assert.deepEqual(schemas(c.state), before);
    assert.equal(hash(config), configHash, "retired config remains available for a compatible importer");
  } },
  { id: "legacy-workboard-direct", route: ["target"], disposition: "blocked", async test(c) {
    await workboard("2026.9.7", "seed", c);
    const retained = () => database(c.state, db => db.prepare("SELECT namespace, entry_key, value_json FROM plugin_state_entries WHERE plugin_id = 'workboard' ORDER BY namespace, entry_key").all());
    const before = retained();
    assert.equal(before.length, 4);
    const result = await c.doctor("target", { allowFailure: true });
    assert.match(result.output, /Workboard has retired pre-July/);
    assert.match(result.output, /2026\.9\.7/);
    assert.deepEqual(retained(), before, "unconverted Workboard rows are retained even if Doctor only warns");
  } },
  { id: "legacy-workboard-bridge", route: ["2026.9.7", "target"], disposition: "supported", async test(c) {
    await workboard("2026.9.7", "seed", c);
    await c.doctor("2026.9.7");
    await workboard("2026.9.7", "verify", c);
    await c.doctor("target");
    await workboard("target", "verify", c);
  } },
  { id: "legacy-history-and-credentials", route: ["2026.9.5", "2026.9.7", "target"], disposition: "supported", async test(c) {
    addHistoryAndCredentials(c.state);
    await c.doctor("2026.9.5");
    await c.doctor("2026.9.7");
    await c.doctor("target");
    historyAndCredentialsSurvive(c.state);
    await c.doctor("target");
    historyAndCredentialsSurvive(c.state);
  } },
  { id: "interrupted-cron-bridge", route: ["2026.9.7 interrupted", "2026.9.7", "target"], disposition: "supported", async test(c) {
    addLegacy(c.state, "cron");
    const result = await c.doctor("2026.9.7", {
      allowFailure: true,
      onOutput: text => /Migrated[^\n]*cron/i.test(text),
    });
    assert.equal(result.interrupted, true, "kill the real Doctor after its cron import and before completion");
    cronSurvives(c.state);
    await c.doctor("2026.9.7"); cronSurvives(c.state);
    await c.doctor("target"); cronSurvives(c.state);
  } },
  { id: "wal-backup-and-restore", route: ["2026.9.7", "2026.9.8", "target", "restore", "2026.9.8"], disposition: "supported", async test(c) {
    addLegacy(c.state, "cron");
    await c.doctor("2026.9.7");
    await c.doctor("2026.9.8");
    const written = await run([path.join(__dirname, "wal.cjs")], c.home, c.log("wal-writer"), {
      onOutput: text => text.includes("WAL committed"),
    });
    assert.equal(written.interrupted, true, "writer exits without checkpointing its committed WAL");
    const wal = path.join(c.state, "state/openclaw.sqlite-wal");
    assert.ok(fs.statSync(wal).size > 32, "backup includes a nonempty WAL");
    const backup = c.home + "-backup";
    fs.cpSync(c.home, backup, { recursive: true });
    const checkMarker = () => assert.equal(database(c.state, db => db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'umbrel.migration.wal-fixture'").get()).value_json, '"retained-wal-payload"');
    await c.doctor("target"); cronSurvives(c.state); checkMarker();
    // A runtime rollback must restore the entire matching snapshot first.
    fs.renameSync(c.home, c.home + "-candidate");
    fs.cpSync(backup, c.home, { recursive: true });
    checkMarker();
    await c.doctor("2026.9.8"); cronSurvives(c.state); checkMarker();
    assert.equal(database(c.state, db => db.prepare("PRAGMA user_version").get()).user_version, versions["2026.9.8"].schemas.state);
  } },
];

async function main() {
  const selected = process.env.MIGRATION_CASES?.split(",");
  if (selected) for (const id of selected) assert.ok(cases.some(c => c.id === id), `unknown case ${id}`);
  const report = {
    versions, architecture: process.arch, node: process.version, cases: [],
    scope: "Optional historical Doctor investigation; recent-version release qualification uses npm run test:upgrades",
    notExercisedByThisSuite: ["channel/plugin-specific state including Matrix", "queued messages and media", "multiple agents and custom workspaces", "storage and permission failures", "production wrapper startup and Gateway readiness"],
  };
  // Doctor performs process discovery and maintenance. Run one case at a time
  // in this PID namespace, even though each case has a separate home.
  const queue = cases.filter(c => !selected || selected.includes(c.id));
  async function worker() {
    while (queue.length) {
      const entry = queue.shift(), home = path.join(root, entry.id);
      const state = createHome(home), original = preserved(state);
      const logs = path.join(outputDir, entry.id);
      fs.mkdirSync(logs, { recursive: true });
      let step = 0;
      const row = { id: entry.id, route: entry.route, disposition: entry.disposition, passed: false, steps: [] };
      const context = {
        home, state, log: name => path.join(logs, `${++step}-${name}.log`),
        async doctor(version, { allowFailure = false, ...options } = {}) {
          const log = context.log(`doctor-${version}`);
          const result = await doctor(version, home, log, options);
          row.steps.push({ version, log: path.relative(outputDir, log), code: result.code, signal: result.signal, interrupted: result.interrupted, timedOut: result.timedOut, durationMs: result.durationMs });
          assert.equal(result.timedOut, false, `${version} Doctor timed out`);
          if (!allowFailure) success(result, `${entry.id} ${version}`);
          return result;
        },
      };
      try {
        await entry.test(context);
        assert.deepEqual(preserved(state), original, "workspace and credentials survive");
        row.schemas = schemas(state);
        for (const [file, info] of Object.entries(row.schemas)) assert.deepEqual(info.integrity, ["ok"], `${file} SQLite integrity`);
        row.passed = true;
      } catch (error) {
        row.error = error.stack; process.exitCode = 1;
        // These homes contain only synthetic data. Keep failed fixtures for
        // diagnosis after the disposable container has been removed.
        try {
          exportFixture(home, path.join(logs, "failed-home"));
        } catch (copyError) { row.fixtureCopyError = copyError.message; }
      }
      report.cases.push(row);
      const pendingReport = path.join(outputDir, "matrix.json.tmp");
      fs.writeFileSync(pendingReport, JSON.stringify(report, null, 2) + "\n");
      fs.renameSync(pendingReport, path.join(outputDir, "matrix.json"));
      console.log(`${row.passed ? "PASS" : "FAIL"} ${entry.id} (${entry.disposition})${row.error ? `: ${row.error}` : ""}`);
    }
  }
  await worker();
  console.log(`Report: ${path.join(outputDir, "matrix.json")}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
