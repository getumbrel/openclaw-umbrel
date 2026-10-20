const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const assert = require("node:assert/strict");

const prefixes = {
  "2026.9.5": "/opt/openclaw-bridges/2026.9.5",
  "2026.9.7": "/opt/openclaw-bridges/2026.9.7",
  "2026.9.8": "/opt/openclaw-bridges/2026.9.8",
  target: "/opt/openclaw-target",
};
const packageRoot = version => path.join(prefixes[version], "lib/node_modules/openclaw");
function environment(home, version = "target") {
  return {
    PATH: `${path.join(prefixes[version], "bin")}:/usr/local/bin:/usr/bin:/bin`,
    HOME: home, OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
    OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw/openclaw.json"),
    OPENCLAW_SERVICE_REPAIR_POLICY: "external", OPENCLAW_SUPERVISOR_MODE: "external",
    OPENCLAW_NO_RESPAWN: "1", NODE_COMPILE_CACHE: "/tmp/migration-lab-compile-cache",
    CI: "1", NO_COLOR: "1",
  };
}

async function run(args, home, log, { timeout = 180000, onOutput, version = "target" } = {}) {
  const fd = fs.openSync(log, "w", 0o600);
  const started = Date.now();
  let output = "", timedOut = false, interrupted = false;
  const child = spawn(process.execPath, args, { env: environment(home, version), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
  function capture(chunk) {
    fs.writeSync(fd, chunk);
    output = (output + chunk.toString()).slice(-8 * 1024 * 1024);
    if (onOutput?.(output) && !interrupted) { interrupted = true; kill(); }
  }
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once("error", error => {
      if (settled) return;
      settled = true; clearTimeout(timer); fs.closeSync(fd); reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); fs.closeSync(fd);
      resolve({ code, signal, timedOut, interrupted, durationMs: Date.now() - started, output });
    });
  });
}

async function doctor(version, home, log, options) {
  return run([path.join(packageRoot(version), "openclaw.mjs"), "doctor", "--repair", "--yes", "--non-interactive"], home, log, { ...options, version });
}
function success(result, context) {
  assert.equal(result.timedOut, false, `${context}: timed out`);
  assert.equal(result.code, 0, `${context}: ${result.output.slice(-4000)}`);
}
function database(state, fn) {
  const db = new DatabaseSync(path.join(state, "state/openclaw.sqlite"), { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function preserved(state) {
  return Object.fromEntries([".env", "workspace/USER.md"].map(file => [file, hash(path.join(state, file))]));
}
function schemas(state) {
  const result = {};
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile() && item.name.endsWith(".sqlite")) {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          result[path.relative(state, file)] = {
            userVersion: db.prepare("PRAGMA user_version").get().user_version,
            integrity: db.prepare("PRAGMA quick_check").all().map(row => Object.values(row)[0]),
          };
        } finally { db.close(); }
      }
    }
  }
  walk(state);
  return result;
}

function readTables(state, table, query) {
  const results = [];
  for (const file of Object.keys(schemas(state))) {
    const db = new DatabaseSync(path.join(state, file), { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)) results.push(...query(db));
    } finally { db.close(); }
  }
  return results;
}

module.exports = { packageRoot, environment, run, doctor, success, database, hash, preserved, schemas, readTables };
