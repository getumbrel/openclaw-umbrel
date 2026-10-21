const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createRequire } = require("node:module");
const { parseEnv } = require("node:util");
const { randomUUID } = require("node:crypto");
const { UpgradeStorage, DIRECTORY, inside, writeJson, processIdentity } = require("./upgrade-storage.cjs");
const { agentDirectories, readProfiles, assertCredentialPreservation } = require("./upgrade-auth.cjs");

const TARGET_ROOT = "/usr/local/lib/node_modules/openclaw";
const BRIDGES = ["2026.9.5", "2026.9.7"];
const rootFor = version => `/opt/openclaw-bridges/${version}/lib/node_modules/openclaw`;
const packageInfo = root => JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const abortError = () => Object.assign(new Error("Upgrade interrupted; recovery will run before the next Gateway start"), { interrupted: true });

function command(args, { env, log, signal, timeout = 300_000, offline = false } = {}) {
  signal?.throwIfAborted();
  const commandId = randomUUID();
  const fd = fs.openSync(log, "w", 0o600);
  const child = spawn(offline ? "/usr/local/libexec/openclaw-migration-offline" : process.execPath,
    offline ? [process.execPath, ...args] : args,
    { env: { ...env, UMBREL_UPGRADE_COMMAND_ID: commandId }, cwd: env.HOME, detached: true, stdio: ["ignore", fd, fd] });
  let interrupted = false, timedOut = false, force;
  const terminate = () => {
    interrupted = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    force = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10_000);
  };
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
  signal?.addEventListener("abort", terminate, { once: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(force);
      signal?.removeEventListener("abort", terminate);
      fs.closeSync(fd);
      if (interrupted) reject(Object.assign(abortError(), { timedOut }));
      else if (error || code !== 0) reject(Object.assign(error || new Error(`Upgrade command failed with exit ${code}; private diagnostics: ${log}`), { cleanupUncertain: true }));
      else {
        // Some tools detach children into another process group. A successful
        // leader exit is insufficient if an inherited command marker is still
        // present in a live descendant. Never start another runtime over it.
        try {
          if (process.platform === "linux") for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
            let variables;
            try { variables = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); }
            catch (error) { if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) continue; throw error; }
            if (variables.includes(`UMBREL_UPGRADE_COMMAND_ID=${commandId}`)) throw new Error("Upgrade command left a running descendant; container restart is required before recovery");
          }
          resolve();
        } catch (error) { reject(Object.assign(error, { cleanupUncertain: true })); }
      }
    };
    child.once("error", error => finish(error));
    child.once("close", code => finish(null, code));
  });
}

function schemaInventory(stateDir, config = {}, home = path.dirname(stateDir)) {
  const result = { state: 0, agent: 0, databases: [] };
  const visited = new Set();
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    const physical = fs.realpathSync(directory);
    if (!inside(home, physical)) throw new Error("Database directory is outside the recoverable persistent home");
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      const stat = item.isSymbolicLink() ? fs.statSync(file) : item;
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile() && item.name.endsWith(".sqlite")) {
        if (!inside(home, fs.realpathSync(file))) throw new Error("Database file is outside the recoverable persistent home");
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          const version = db.prepare("PRAGMA user_version").get().user_version;
          if (db.prepare("PRAGMA quick_check").all().some(row => Object.values(row)[0] !== "ok")) throw new Error(`Database integrity check failed: ${path.relative(stateDir, file)}`);
          const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
          let kind;
          if (file === path.join(stateDir, "state/openclaw.sqlite")) kind = "state";
          else if (item.name === "openclaw-agent.sqlite" || tables.has("session_nodes")) kind = "agent";
          if (kind) result[kind] = Math.max(result[kind], version);
          result.databases.push({ path: path.relative(stateDir, file), kind, version });
        } finally { db.close(); }
      }
    }
  }
  visit(stateDir);
  for (const directory of agentDirectories(stateDir, config, home)) visit(directory);
  return result;
}
function compatible(schemas, pkg) {
  const limits = pkg.openclaw?.schemaVersions;
  if (!limits || !Number.isInteger(limits.state) || !Number.isInteger(limits.agent)) throw new Error("Package does not declare its supported database schemas");
  return schemas.state <= limits.state && schemas.agent <= limits.agent;
}

function inspectPaths(home, stateDir) {
  const visited = new Set();
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    const physical = fs.realpathSync(directory);
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (!inside(home, target) || inside(path.join(home, DIRECTORY), target)) throw new Error(`State links outside the recoverable persistent home: ${path.relative(stateDir, file)}`);
        if (fs.statSync(file).isDirectory()) visit(file);
      } else if (item.isDirectory()) visit(file);
    }
  }
  if (fs.existsSync(stateDir) && fs.realpathSync(stateDir) !== stateDir) throw new Error("State directory must not be a symlink during an upgrade");
  visit(stateDir);
}

function inspectConfigPaths(home, stateDir, targetRoot) {
  const JSON5 = createRequire(path.join(targetRoot, "package.json"))("json5");
  const seen = new Set();
  function dataPath(value, label, relativeTo = home) {
    const expanded = value.replace(/^~(?=\/|$)/, home)
      .replaceAll("${HOME}", home).replaceAll("${OPENCLAW_STATE_DIR}", stateDir);
    if (expanded.includes("${")) throw new Error(`Cannot snapshot an unresolved data path: ${label}`);
    const file = path.resolve(relativeTo, expanded);
    let existing = file;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    if (!inside(home, file) || !inside(home, fs.realpathSync(existing)) || inside(path.join(home, DIRECTORY), file) || inside(path.join(home, DIRECTORY), fs.realpathSync(existing))) throw new Error(`Configured data path is outside the recoverable persistent home: ${label}`);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) inspectPaths(home, fs.realpathSync(file));
    return file;
  }
  function inspect(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const raw = JSON5.parse(fs.readFileSync(file, "utf8"));
    function visit(value, keys = []) {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const label = [...keys, key].join(".");
        if (key === "$include") {
          for (const include of Array.isArray(child) ? child : [child]) {
            if (typeof include !== "string") throw new Error("Invalid configuration include");
            inspect(dataPath(include, label, path.dirname(file)));
          }
        } else if (typeof child === "string" && (
          ["workspace", "cwd", "agentDir", "stateDir", "dataDir", "credentialsPath", "credentialPath", "authDir", "workspaceRoot"].includes(key) ||
          key === "store" && ["session", "cron"].includes(keys.at(-1)) ||
          key === "path" && keys.at(-1) === "store" ||
          key === "file" && keys.at(-1) === "logging"
        )) dataPath(child, label);
        else visit(child, [...keys, key]);
      }
    }
    visit(raw);
  }
  inspect(path.join(stateDir, "openclaw.json"));
}

// These formats are silently ignored by later releases in some configurations.
// Until their current-schema importer is verified, refuse instead of losing the
// ability to use retained state when a disabled channel is enabled in future.
function requiresOldDataImporter(stateDir) {
  const found = [];
  const visited = new Set();
  for (const relative of ["tasks/runs.sqlite", "flows/registry.sqlite", "plugin-state/state.sqlite", "credentials/oauth.json", "plugins/installs.json"]) {
    if (fs.existsSync(path.join(stateDir, relative))) found.push(relative);
  }
  for (const channel of ["telegram", "imessage", "msteams", "nostr", "active-memory"]) {
    const directory = path.join(stateDir, channel);
    if (!fs.existsSync(directory)) continue;
    function visit(dir) {
      const physical = fs.realpathSync(dir);
      if (visited.has(physical)) return;
      visited.add(physical);
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        const stat = item.isSymbolicLink() ? fs.statSync(file) : item;
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile() && item.name.endsWith(".json")) found.push(path.relative(stateDir, file));
      }
    }
    visit(directory);
  }
  return found;
}
function assertSupportedMatrixState(home, stateDir) {
  if (["matrix/bot-storage.json", "matrix/crypto"].some(file => fs.existsSync(path.join(stateDir, file)))) {
    throw new Error("The original Matrix storage layout requires the 2026.6 migration and Gateway start, followed by 2026.9.5 and a Matrix start; this update is paused with the original data unchanged");
  }
  const retired = new Set(["thread-bindings.json", "startup-verification.json", "recovery-key.json", "legacy-crypto-migration.json", "crypto-idb-snapshot.json", "storage-meta.json", "inbound-dedupe.json"]);
  const visited = new Set();
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    const physical = fs.realpathSync(directory);
    if (!inside(home, physical) || inside(path.join(home, DIRECTORY), physical)) throw new Error("Matrix state is outside the recoverable persistent home");
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      // Even a disabled account must not silently lose its future import path.
      // Archived *.migrated files are evidence, not pending imports.
      if (retired.has(item.name)) throw new Error(`Retired Matrix state (${item.name}) requires 2026.9.5 Doctor and a Matrix channel start; this update is paused with the original data unchanged`);
      const stat = item.isSymbolicLink() ? fs.statSync(file) : item;
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(path.join(stateDir, "matrix"));
}
function pendingWorkboard(stateDir) {
  const file = path.join(stateDir, "state/openclaw.sqlite");
  if (!fs.existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_state_entries'").get()) return false;
    return Boolean(db.prepare("SELECT 1 FROM plugin_state_entries WHERE plugin_id='workboard' AND namespace IN ('workboard.boards','workboard.cards','workboard.notify','workboard.attachments') LIMIT 1").get());
  } finally { db.close(); }
}
function assertSettledLegacyData(stateDir) {
  if (pendingWorkboard(stateDir)) throw new Error("Retired Workboard records have not been imported; refusing activation even if Doctor returned success");
  for (const file of ["cron/jobs.json", "settings/voicewake.json"]) {
    if (fs.existsSync(path.join(stateDir, file))) throw new Error(`Retired state was not migrated: ${file}`);
  }
  if (requiresOldDataImporter(stateDir).length) throw new Error("Retired channel or plugin data was not fully imported; refusing activation");
}

async function ensureUpgrade({ home, stateDir, targetRoot = TARGET_ROOT, bridgeRoot = rootFor, retry = false, signal, reconcile = async () => {}, run = command, progress = () => {}, storageOptions, externallyLocked = false, checkpoint = async () => {}, containerIdentity = () => processIdentity(1) }) {
  const storage = new UpgradeStorage(home, stateDir, storageOptions);
  home = storage.home;
  stateDir = storage.stateDir;
  // Production uses a kernel flock held by the worker itself. A power loss
  // cannot leave a truncated PID lock blocking automatic recovery.
  const unlock = externallyLocked ? () => {} : storage.lock();
  let journal;
  try {
    const target = packageInfo(targetRoot);
    journal = storage.read();
    if (journal?.phase === "snapshotting" && !journal.snapshotReady) storage.discardIncomplete(journal);
    if (journal && ["migrating", "validating", "restoring"].includes(journal.phase)) {
      if (journal.containerIdentity === containerIdentity()) throw Object.assign(new Error("Container restart is required before recovering this interrupted upgrade"), { cleanupUncertain: true });
      progress("Restoring the verified pre-upgrade snapshot");
      storage.restore(journal);
      throw new Error("An interrupted upgrade was rolled back. Retry the update when ready.");
    }
    if (journal?.phase === "committed" && journal.target === target.version) return { upgraded: false, target: target.version };
    if (journal?.phase === "failed" && !retry) throw new Error("The previous upgrade did not complete. Original data is retained; retry is required.");
    inspectPaths(storage.home, storage.stateDir);
    const configFile = path.join(stateDir, "openclaw.json");
    const existing = fs.existsSync(stateDir) && fs.readdirSync(stateDir).some(name => name !== "workspace" || fs.readdirSync(path.join(stateDir, name)).length > 0);
    if (!existing) return { upgraded: false, fresh: true, target: target.version };
    if (!fs.existsSync(configFile)) throw new Error("Retained OpenClaw data has no configuration; refusing to treat it as a fresh install");
    assertSupportedMatrixState(home, stateDir);
    inspectConfigPaths(storage.home, stateDir, targetRoot);
    progress("Creating and verifying the complete pre-upgrade snapshot");
    journal = storage.snapshot(target.version);
    await checkpoint("prepared", journal);
    signal?.throwIfAborted();
    const directory = storage.directory(journal);
    const envFile = path.join(stateDir, ".env");
    const persistedEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {};
    const env = {
      ...process.env, ...persistedEnv, HOME: storage.home, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configFile,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external", OPENCLAW_SUPERVISOR_MODE: "external", OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0", OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_PROVIDERS: "1", OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1", OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      PATH: "/usr/local/bin:/usr/bin:/bin", NODE_COMPILE_CACHE: path.join(directory, "compile-cache"),
    };
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCLAW_OAUTH_DIR", "OPENCLAW_WORKSPACE_DIR"]) {
      if (!env[key]) continue;
      let existing = path.resolve(env[key]);
      while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
      if (!path.isAbsolute(env[key]) || !inside(home, env[key]) || !inside(home, fs.realpathSync(existing)) || inside(path.join(home, DIRECTORY), env[key]) || inside(path.join(home, DIRECTORY), fs.realpathSync(existing))) throw new Error(`Environment data path is outside the recoverable persistent home: ${key}`);
      if (fs.existsSync(env[key]) && fs.statSync(env[key]).isDirectory()) inspectPaths(home, fs.realpathSync(env[key]));
    }
    for (const key of ["OPENCLAW_HOME", "OPENCLAW_PROFILE", "OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
      if (env[key]) throw new Error(`An alternate state selector requires inspection before migration: ${key}`);
      // An empty override also prevents upstream's .env loader from restoring
      // a selector that was removed from the maintenance environment.
      env[key] = "";
    }
    // Explicit state selectors and auth overrides inherited from another CLI
    // must not redirect maintenance outside this transaction.
    env.NODE_OPTIONS = "";
    for (const key of ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_UPDATE_IN_PROGRESS", "OPENCLAW_UPDATE_RUN_ID"]) delete env[key];
    const parseConfig = () => createRequire(path.join(targetRoot, "package.json"))("json5").parse(fs.readFileSync(configFile, "utf8"));
    const schemas = schemaInventory(stateDir, parseConfig(), home);
    if (!compatible(schemas, target)) throw new Error("The installed image is older than the retained databases; a runtime downgrade is not safe");
    const packages = BRIDGES.map(version => {
      const root = bridgeRoot(version), pkg = packageInfo(root);
      if (pkg.version !== version) throw new Error(`Expected bridge ${version}`);
      return { root, pkg, version };
    });
    const plan = packages.filter(entry => compatible(schemas, entry.pkg));
    const hasTelegramExecutor = plan.some(entry => entry.version === "2026.9.7");
    if (!plan.some(entry => entry.version === "2026.9.5") && requiresOldDataImporter(stateDir).some(file => !hasTelegramExecutor || !file.startsWith("telegram/"))) {
      throw new Error("Retained legacy channel or plugin data needs a database-compatible importer; no older runtime was started");
    }
    if (!plan.some(entry => entry.version === "2026.9.7") && pendingWorkboard(stateDir)) throw new Error("Retired Workboard records need a database-compatible importer; no older runtime was started");
    storage.write(journal, "migrating", { schemas, bridges: plan.map(entry => entry.version), containerIdentity: containerIdentity() });
    await checkpoint("migrating", journal);
    const authResultPath = path.join(directory, "oauth.json");
    await run([path.join(__dirname, "upgrade-runtime.mjs"), "oauth", bridgeRoot("2026.9.7"), authResultPath], { env, signal, offline: true, log: path.join(directory, "oauth.log") });
    const credentials = readProfiles(stateDir, parseConfig(), schemas.databases);
    assertCredentialPreservation(credentials, credentials);
    const profileIdMap = new Map();
    if (!plan.some(entry => entry.version === "2026.9.5")) {
      progress("Repairing older configuration without opening databases through an old runtime");
      const resultPath = path.join(directory, "configuration.json");
      await run([path.join(__dirname, "upgrade-runtime.mjs"), "needs-config", targetRoot, resultPath], { env, signal, offline: true, log: path.join(directory, "configuration-inspection.log") });
      if (JSON.parse(fs.readFileSync(resultPath, "utf8")).required) {
        await run([path.join(__dirname, "upgrade-runtime.mjs"), "config", bridgeRoot("2026.9.5"), resultPath], { env, signal, offline: true, log: path.join(directory, "configuration.log") });
        const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        if (result.changed) writeJson(configFile, result.config);
      }
    }
    for (const entry of [...plan, { root: targetRoot, version: target.version }]) {
      signal?.throwIfAborted();
      // Recheck after every migration, not just at plan construction.
      if (!compatible(schemaInventory(stateDir, parseConfig(), home), packageInfo(entry.root))) throw new Error(`Database schemas exceed bridge ${entry.version}`);
      // The upstream census can initialize database-backed ownership metadata.
      // Run it only through this already-admitted package, never the target
      // ahead of older bridges. Compose its exact collision-safe ID mappings.
      const authMapPath = path.join(directory, `auth-map-${entry.version}.json`);
      await run([path.join(__dirname, "upgrade-runtime.mjs"), "auth-map", entry.root, authMapPath], { env, signal, offline: true, log: path.join(directory, `auth-map-${entry.version}.log`) });
      const stepMap = new Map(JSON.parse(fs.readFileSync(authMapPath, "utf8")).profileIds);
      for (const { id } of credentials) {
        const current = profileIdMap.get(id) || id;
        if (stepMap.has(current)) profileIdMap.set(id, stepMap.get(current));
      }
      if (!compatible(schemaInventory(stateDir, parseConfig(), home), packageInfo(entry.root))) throw new Error(`Auth planning exceeded bridge ${entry.version}`);
      if (entry.version === "2026.9.7") {
        progress("Importing retained Telegram files with the compatible database runtime");
        await run([path.join(__dirname, "upgrade-runtime.mjs"), "telegram", entry.root, path.join(directory, "telegram.json"), bridgeRoot("2026.9.5")], { env, signal, offline: true, log: path.join(directory, "telegram.log") });
      }
      progress(`Migrating with OpenClaw ${entry.version}`);
      const stepEnv = {
        ...env, PATH: `${path.resolve(entry.root, "../../../bin")}:${env.PATH}`,
        // Use upstream's update handoff contract to defer package downloads.
        // The candidate startup check must accept the installed payloads before
        // activation. npm offline also makes any missed lookup fail promptly.
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        npm_config_offline: "true", npm_config_fetch_retries: "0",
      };
      await run([path.join(entry.root, "openclaw.mjs"), "doctor", "--repair", "--yes", "--non-interactive", "--no-workspace-suggestions"], { env: stepEnv, signal, offline: true, log: path.join(directory, `doctor-${entry.version}.log`) });
      await checkpoint(`doctor-${entry.version}`, journal);
    }
    await reconcile();
    const finalEnv = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")) : {};
    for (const [key, value] of Object.entries(persistedEnv)) {
      if (!["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"].includes(key) && finalEnv[key] !== value) throw new Error(`Saved environment setting did not survive configuration reconciliation: ${key}`);
    }
    await run([path.join(targetRoot, "openclaw.mjs"), "plugins", "registry", "--refresh", "--json"], { env: { ...env, npm_config_offline: "true", npm_config_fetch_retries: "0" }, signal, offline: true, log: path.join(directory, "plugin-registry.log") });
    storage.write(journal, "validating");
    await checkpoint("validating", journal);
    progress("Verifying the upgraded databases and isolated Gateway startup");
    const finalSchemas = schemaInventory(stateDir, parseConfig(), home);
    assertSettledLegacyData(stateDir);
    assertCredentialPreservation(credentials, readProfiles(stateDir, parseConfig(), finalSchemas.databases, { canonicalOnly: true }), { profileIdMap, requireCanonical: true });
    await run([path.join(__dirname, "upgrade-runtime.mjs"), "canary", targetRoot, path.join(directory, "readiness.json")], { env, signal, log: path.join(directory, "readiness.log"), timeout: 600_000 });
    signal?.throwIfAborted();
    storage.write(journal, "committed", { finalSchemas });
    await checkpoint("committed", journal);
    return { upgraded: true, target: target.version, backup: path.join(directory, "original") };
  } catch (error) {
    // A killed command may own detached descendants. Never restore while their
    // shutdown is uncertain; the next container startup restores before launch.
    if (journal?.snapshotReady && ["migrating", "validating"].includes(journal.phase) && !error.interrupted && !error.cleanupUncertain && !signal?.aborted) {
      progress("Upgrade could not complete; restoring original data");
      storage.restore(journal);
    } else if (journal && ["snapshotting", "prepared"].includes(journal.phase)) storage.write(journal, "failed", { restored: false });
    throw error;
  } finally { unlock(); }
}

module.exports = { ensureUpgrade, schemaInventory, compatible, command, requiresOldDataImporter };
