const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHome, addLegacy, addHistoryAndCredentials } = require("./fixtures.cjs");
const { inventory, sameInventory, DIRECTORY } = require("/app/upgrade-storage.cjs");
const home = process.env.HOME;
const state = path.join(home, ".openclaw");
const operation = process.argv[2];
if (operation === "seed") {
  createHome(home);
  for (const kind of ["config", "cron", "voicewake"]) addLegacy(state, kind);
  addHistoryAndCredentials(state);
  fs.mkdirSync(path.join(home, "linuxbrew"), { recursive: true });
  fs.writeFileSync(path.join(home, "linuxbrew/retained.txt"), "same bind mount after recovery\n");
  fs.writeFileSync("/results/wrapper-before.json", JSON.stringify(inventory(home)), { mode: 0o644 });
} else if (operation === "status") {
  let journal;
  try { journal = JSON.parse(fs.readFileSync(path.join(home, DIRECTORY, "journal.json"))); } catch {}
  console.log(JSON.stringify({ phase: journal?.phase, restored: journal?.restored, id: journal?.id, database: fs.existsSync(path.join(state, "state/openclaw.sqlite")) }));
} else if (operation === "restored") {
  sameInventory(inventory(home, { exclude: [DIRECTORY] }), JSON.parse(fs.readFileSync("/results/wrapper-before.json")));
  assert.equal(fs.readFileSync("/home/linuxbrew/retained.txt", "utf8"), "same bind mount after recovery\n");
  console.log("PASS: interrupted production wrapper restores every original byte and mode, including the second bind mount");
} else if (operation === "fresh") {
  assert.equal(fs.existsSync(path.join(state, "openclaw.json")), false);
  assert.equal(fs.existsSync(path.join(home, DIRECTORY, "journal.json")), false);
  assert.equal(fs.existsSync(path.join(home, "linuxbrew/.linuxbrew/bin/brew")), true);
  console.log("PASS: fresh installation reaches setup and initializes the production home skeleton");
} else throw new Error("Unknown wrapper fixture operation");
