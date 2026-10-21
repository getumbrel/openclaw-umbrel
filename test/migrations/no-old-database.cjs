// Test-only proof that the 9.5 Telegram parser never opens any SQLite database.
// The production implementation does not patch node:sqlite or schema guards.
const sqlite = require("node:sqlite");
const { syncBuiltinESMExports } = require("node:module");
const OriginalDatabase = sqlite.DatabaseSync;
sqlite.DatabaseSync = class extends OriginalDatabase {
  constructor(...args) {
    if (new Error().stack.includes("/openclaw-bridges/2026.9.5/")) throw new Error("Old Telegram parser attempted to open SQLite");
    super(...args);
  }
};
syncBuiltinESMExports();
console.log("Old-package SQLite guard armed for this test process");
