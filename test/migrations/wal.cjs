const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(path.join(process.env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
db.prepare("INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)")
  .run("umbrel.migration.wal-fixture", '"retained-wal-payload"', Date.now());
console.log("WAL committed");
// The parent kills this fixture process after the commit, leaving the WAL that
// an unclean shutdown can leave for the next app version.
setInterval(() => {}, 1000);
