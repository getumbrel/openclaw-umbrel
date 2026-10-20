const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { zstdDecompressSync } = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { createHome, addLegacy, addHistoryAndCredentials, job, credential, voicewake, conversation, sessionId } = require("./fixtures.cjs");
const { addOAuth, profileId, material, metadata } = require("./oauth-fixture.cjs");
const { doctor, success, database, schemas, readTables, run, packageRoot } = require("./lab.cjs");
const { ensureUpgrade, schemaInventory } = require("/app/upgrade.cjs");
const { inventory, sameInventory, DIRECTORY } = require("/app/upgrade-storage.cjs");

async function main() {
  const id = process.argv[2] || "mixed-config";
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `umbrel-upgrade-${id}-`));
  const stateDir = createHome(home);
  const results = path.join(process.env.MIGRATION_REPORT_DIR || "/results", `upgrade-${id}`);
  fs.mkdirSync(results, { recursive: true });
  process.env.HOME = home;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const { reconcileConfig } = require("/app/setup-server.cjs");
  const secondSession = "cf982bc3-c9bc-4138-b49a-8403877dc3b5";
  const secondMessages = ["The second agent has separate history.", "Keep this second conversation."];
  const secondCredential = { ...credential, key: "synthetic-second-profile-key" };
  const mediaBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
  const mediaPath = path.join(stateDir, "media/inbound/retained.png");
  const deliveryId = "056535ef-ccdb-4813-bf3a-7f0d9604f770";
  const deliveredId = "056535ef-ccdb-4813-bf3a-7f0d9604f771";
  if (id === "mixed-config") {
    success(await doctor("2026.9.8", home, path.join(results, "baseline.log")), "baseline");
    addLegacy(stateDir, "config");
  } else if (id === "legacy") {
    addLegacy(stateDir, "config");
    addLegacy(stateDir, "cron");
    addLegacy(stateDir, "voicewake");
    addHistoryAndCredentials(stateDir);
  } else if (id.startsWith("oauth-")) {
    if (["oauth-schema20", "oauth-sqlite-reference"].includes(id)) success(await doctor("target", home, path.join(results, "baseline.log")), "schema 20 baseline");
    addOAuth(home, stateDir, { missingKey: id === "oauth-missing-key", envKey: id === "oauth-env-key", tampered: id === "oauth-tampered" });
    if (id === "oauth-sqlite-reference") {
      const file = path.join(stateDir, "agents/main/agent/auth-profiles.json");
      const db = new DatabaseSync(path.join(stateDir, "state/openclaw.sqlite"));
      try { db.prepare("INSERT OR REPLACE INTO config_machine_state (state_key,value_json,updated_at_ms) VALUES ('authProfiles.store',?,?)").run(fs.readFileSync(file, "utf8"), Date.now()); }
      finally { db.close(); }
      fs.unlinkSync(file);
    }
  } else if (["workboard", "workboard-schema20"].includes(id)) {
    const configFile = path.join(stateDir, "openclaw.json");
    const config = JSON.parse(fs.readFileSync(configFile));
    if (id === "workboard") config.plugins = { enabled: true, allow: ["workboard"], entries: { workboard: { enabled: true } } };
    fs.writeFileSync(configFile, JSON.stringify(config));
    success(await run([path.join(__dirname, "workboard.mjs"), packageRoot("2026.9.7"), "seed"], home, path.join(results, "seed.log"), { version: "2026.9.7" }), "Workboard seed");
    if (id === "workboard-schema20") success(await doctor("target", home, path.join(results, "baseline.log")), "schema 20 with retained Workboard records");
  } else if (id === "multiagent") {
    const workspace = path.join(home, "second-workspace"), agentDir = path.join(home, "second-agent");
    fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "SOUL.md"), "Second agent's retained instructions.\n");
    const file = path.join(stateDir, "openclaw.json"), config = JSON.parse(fs.readFileSync(file));
    config.agents.entries.second = { workspace, agentDir };
    fs.writeFileSync(file, JSON.stringify(config));
    addHistoryAndCredentials(stateDir);
    addHistoryAndCredentials(stateDir, { agentId: "second", id: secondSession, profileId: "openai:migration-test", account: secondCredential, messages: secondMessages, agentDir, workspace });
  } else if (id === "queued-media") {
    addHistoryAndCredentials(stateDir);
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true }); fs.writeFileSync(mediaPath, mediaBytes);
    const transcript = path.join(stateDir, "agents/main/sessions", `${sessionId}.jsonl`);
    const events = fs.readFileSync(transcript, "utf8").trim().split("\n").map(JSON.parse);
    Object.assign(events[1].message, { MediaPath: mediaPath, MediaType: "image/png" });
    fs.writeFileSync(transcript, events.map(e => JSON.stringify(e)).join("\n") + "\n");
    // Shape and two-phase delivered marker from v2026.4.1
    // src/infra/outbound/delivery-queue-storage.ts.
    const entry = { id: deliveryId, enqueuedAt: Date.now(), channel: "telegram", to: "12345", accountId: "default", payloads: [{ text: "Retained queued caption", mediaUrl: mediaPath }], retryCount: 0, silent: true };
    fs.mkdirSync(path.join(stateDir, "delivery-queue"));
    fs.writeFileSync(path.join(stateDir, "delivery-queue", `${deliveryId}.json`), JSON.stringify(entry));
    fs.writeFileSync(path.join(stateDir, "delivery-queue", `${deliveredId}.delivered`), JSON.stringify({ ...entry, id: deliveredId, payloads: [{ text: "Already delivered; never replay" }] }));
  } else throw new Error(`Unknown upgrade fixture ${id}`);
  const refused = ["oauth-missing-key", "oauth-tampered", "oauth-sqlite-reference", "workboard-schema20"].includes(id);
  const retained = path.join(home, "custom-workspace/retained.bin");
  fs.mkdirSync(path.dirname(retained), { recursive: true, mode: 0o700 });
  fs.writeFileSync(retained, Buffer.from([0, 255, 17, 42]));
  const before = inventory(home);
  try {
    if (refused) {
      await assert.rejects(ensureUpgrade({ home, stateDir, reconcile: reconcileConfig }), /Upgrade command failed|could not be recovered|database-compatible importer/);
      // Core recovery test. A separate wrapper/container test exercises actual
      // PID-namespace replacement; here the identity is explicitly injected.
      if (["oauth-missing-key", "oauth-tampered"].includes(id)) await assert.rejects(ensureUpgrade({ home, stateDir, containerIdentity: () => "replacement-fixture-container" }), /rolled back/);
      sameInventory(inventory(home, { exclude: [DIRECTORY] }), before);
      fs.writeFileSync(path.join(results, "result.json"), JSON.stringify({ id, passed: true, disposition: "refused-and-restored" }, null, 2));
      console.log(`PASS refused and restored: ${id}`);
      return;
    }
    const result = await ensureUpgrade({ home, stateDir, reconcile: reconcileConfig, progress: message => console.log(message) });
    assert.equal(result.upgraded, true);
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json")));
    if (["mixed-config", "legacy"].includes(id)) {
      assert.equal(config.agents.defaults.heartbeat.every, "37m");
      assert.equal(config.heartbeat, undefined);
    }
    assert.equal(config.gateway.auth.mode, "trusted-proxy");
    if (id === "legacy") {
      const rows = database(stateDir, db => db.prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?").all(job.id));
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0].job_json).payload, job.payload);
      const auth = database(stateDir, db => db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get());
      assert.deepEqual(JSON.parse(auth.value_json).profiles["openai:migration-test"], credential);
      const wake = database(stateDir, db => db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'voicewake.triggers'").get());
      assert.deepEqual(JSON.parse(wake.value_json), voicewake.triggers);
      const sessions = readTables(stateDir, "session_nodes", db => db.prepare("SELECT entry_json FROM session_nodes WHERE session_key = 'agent:main:main'").all());
      assert.equal(sessions.length, 1);
      const events = readTables(stateDir, "transcript_events", db => db.prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq").all(sessionId));
      const texts = events.flatMap(row => JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString()).message?.content?.filter(c => c.type === "text").map(c => c.text) ?? []);
      assert.deepEqual(texts, conversation);
    } else if (id.startsWith("oauth-")) {
      const auth = database(stateDir, db => db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get());
      const profiles = JSON.parse(auth.value_json).profiles;
      assert.deepEqual(profiles[profileId.replace("openai-codex:", "openai:")], { ...metadata, provider: "openai", ...material });
    } else if (id === "workboard") {
      success(await run([path.join(__dirname, "workboard.mjs"), packageRoot("target"), "verify"], home, path.join(results, "verify.log")), "Workboard content");
    } else if (id === "multiagent") {
      const final = schemaInventory(stateDir, config, home), messages = [];
      for (const info of final.databases) {
        const db = new DatabaseSync(path.join(stateDir, info.path), { readOnly: true });
        try {
          if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='transcript_events'").get()) continue;
          for (const row of db.prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq").all(secondSession)) {
            const event = JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString());
            messages.push(...(event.message?.content?.filter(c => c.type === "text").map(c => c.text) || []));
          }
        } finally { db.close(); }
      }
      assert.deepEqual(messages, secondMessages);
      const agentDb = new DatabaseSync(path.join(home, "second-agent/openclaw-agent.sqlite"), { readOnly: true });
      try {
        const auth = agentDb.prepare("SELECT store_json FROM auth_profile_store WHERE store_key='primary'").get();
        assert.deepEqual(JSON.parse(auth.store_json).profiles["openai:migration-test"], secondCredential);
      } finally { agentDb.close(); }
      const shared = database(stateDir, db => db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'authProfiles.store'").get());
      assert.deepEqual(JSON.parse(shared.value_json).profiles["openai:migration-test"], credential);
      assert.equal(fs.readFileSync(path.join(home, "second-workspace/SOUL.md"), "utf8"), "Second agent's retained instructions.\n");
      assert.equal(config.agents.entries.second.workspace, path.join(home, "second-workspace"));
    } else if (id === "queued-media") {
      assert.deepEqual(fs.readFileSync(mediaPath), mediaBytes);
      const events = readTables(stateDir, "transcript_events", db => db.prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq").all(sessionId));
      const user = events.map(row => JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString())).find(event => event.message?.role === "user").message;
      assert.equal(user.MediaPath, undefined);
      assert.ok(user.__openclaw?.media?.some(item => item.path === mediaPath && item.contentType === "image/png"));
      database(stateDir, db => {
        const rows = db.prepare("SELECT * FROM delivery_queue_entries").all();
        fs.writeFileSync(path.join(results, "delivery-records.json"), JSON.stringify(rows, null, 2));
        const serialized = JSON.stringify(rows);
        assert.ok(serialized.includes(deliveryId));
        assert.ok(serialized.includes("Retained queued caption"));
        assert.ok(!serialized.includes(deliveredId), "delivered marker must never become pending work");
        const retained = rows.filter(row => row.id === deliveryId);
        assert.equal(retained.length, 1);
        assert.equal(retained[0].status, "pending");
        assert.equal(retained[0].channel, "telegram");
        assert.equal(retained[0].target, "12345");
        assert.equal(retained[0].retry_count, 0);
        assert.equal(JSON.parse(retained[0].entry_json).payloads[0].mediaUrl, mediaPath);
      });
    }
    assert.deepEqual(fs.readFileSync(retained), Buffer.from([0, 255, 17, 42]));
    sameInventory(inventory(result.backup), before);
    const restarted = await ensureUpgrade({ home, stateDir, reconcile: () => { throw new Error("Repeated migration on ordinary restart"); } });
    assert.equal(restarted.upgraded, false);
    fs.writeFileSync(path.join(results, "result.json"), JSON.stringify({ id, passed: true, disposition: "upgraded", target: result.target, schemas: schemas(stateDir) }, null, 2));
    console.log(`PASS production upgrade: ${id}`);
  } finally {
    // Synthetic only; publish private production logs with readable copies.
    const from = path.join(home, DIRECTORY);
    fs.writeFileSync(path.join(results, "home-inventory.json"), JSON.stringify(inventory(home, { exclude: [DIRECTORY] }), null, 2));
    function readable(dir) {
      fs.chmodSync(dir, 0o755);
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) readable(file);
        else if (item.isFile()) fs.chmodSync(file, 0o644);
      }
    }
    fs.cpSync(home, path.join(results, "final-home"), { recursive: true, dereference: false, filter: file => file !== from });
    readable(path.join(results, "final-home"));
    if (fs.existsSync(from)) {
      for (const name of fs.readdirSync(from)) {
        const original = path.join(from, name, "original");
        if (fs.existsSync(original)) fs.writeFileSync(path.join(results, "backup-inventory.json"), JSON.stringify(inventory(original), null, 2));
      }
      fs.cpSync(from, path.join(results, "transaction"), { recursive: true, dereference: false, filter: file => path.basename(file) !== "compile-cache" });
      readable(path.join(results, "transaction"));
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
