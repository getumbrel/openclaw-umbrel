const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

function agentDirectories(stateDir, config, home = process.env.HOME) {
  const directories = new Set([path.join(stateDir, "agent")]);
  const agents = path.join(stateDir, "agents");
  if (fs.existsSync(agents)) for (const id of fs.readdirSync(agents)) directories.add(path.join(agents, id, "agent"));
  for (const agent of [...Object.values(config.agents?.entries || {}), ...(config.agents?.list || [])]) if (typeof agent?.agentDir === "string") {
    const directory = agent.agentDir.replace(/^~(?=\/|$)/, home).replaceAll("${HOME}", home).replaceAll("${OPENCLAW_STATE_DIR}", stateDir);
    directories.add(path.resolve(home, directory));
  }
  return [...directories];
}
function legacyAuthFiles(stateDir, config) {
  const files = new Set([path.join(stateDir, "auth-profiles.json"), path.join(stateDir, "agent/auth-profiles.json")]);
  for (const directory of agentDirectories(stateDir, config)) files.add(path.join(directory, "auth-profiles.json"));
  return [...files].filter(file => fs.existsSync(file));
}
// Read opaque credential stores without loading an old runtime against the
// installed schema. The primary store moved from agent SQLite to shared SQLite
// before the last public Umbrel release; either can retain an OAuth reference.
function canonicalAuthStores(stateDir, databases) {
  const stores = [];
  for (const info of databases) {
    if (!info.kind) continue;
    const file = path.join(stateDir, info.path);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
      if (tables.has("config_machine_state")) for (const row of db.prepare("SELECT value_json AS json FROM config_machine_state WHERE state_key = 'authProfiles.store'").all()) {
        stores.push({ kind: "shared", file, key: "authProfiles.store", json: row.json, raw: JSON.parse(row.json) });
      }
      if (tables.has("auth_profile_store")) for (const row of db.prepare("SELECT store_key, store_json AS json FROM auth_profile_store").all()) {
        stores.push({ kind: "agent", file, key: row.store_key, json: row.json, raw: JSON.parse(row.json) });
      }
    } finally { db.close(); }
  }
  return stores;
}
function replaceCanonicalAuthStore(store, repaired) {
  if (!["shared", "agent"].includes(store.kind)) throw new Error("Unknown canonical credential store");
  const db = new DatabaseSync(store.file);
  try {
    db.exec("BEGIN IMMEDIATE");
    const sql = store.kind === "shared"
      ? "UPDATE config_machine_state SET value_json = ? WHERE state_key = ? AND value_json = ?"
      : "UPDATE auth_profile_store SET store_json = ? WHERE store_key = ? AND store_json = ?";
    // Keep all store metadata and timestamps; only the verified credential JSON
    // changes. A competing writer must never be silently overwritten.
    if (db.prepare(sql).run(JSON.stringify(repaired), store.key, store.json).changes !== 1) throw new Error("Canonical credentials changed during repair; refusing to overwrite them");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.close(); }
}
function readProfiles(stateDir, config, databases, { canonicalOnly = false } = {}) {
  const canonical = [], legacy = [];
  const sharedDirectories = new Set([stateDir, path.join(stateDir, "agent"), path.join(stateDir, "agents/main/agent")].map(directory => fs.existsSync(directory) ? fs.realpathSync(directory) : directory));
  const scopeFor = directory => {
    const physical = fs.realpathSync(directory);
    return sharedDirectories.has(physical) ? "shared" : physical;
  };
  for (const info of databases) {
    if (!info.kind) continue;
    const db = new DatabaseSync(path.join(stateDir, info.path), { readOnly: true });
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
      const stores = [];
      if (tables.has("config_machine_state")) stores.push(...db.prepare("SELECT value_json AS json FROM config_machine_state WHERE state_key = 'authProfiles.store'").all().map(row => ({ ...row, scope: "shared" })));
      if (tables.has("auth_profile_store")) stores.push(...db.prepare("SELECT store_json AS json FROM auth_profile_store").all().map(row => ({ ...row, scope: scopeFor(path.dirname(path.join(stateDir, info.path))) })));
      for (const store of stores) for (const [id, credential] of Object.entries(JSON.parse(store.json).profiles || {})) canonical.push({ id, scope: store.scope, credential });
    } finally { db.close(); }
  }
  if (!canonicalOnly) for (const file of legacyAuthFiles(stateDir, config)) {
    for (const [id, credential] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")).profiles || {})) legacy.push({ id, scope: scopeFor(path.dirname(file)), credential });
  }
  const combined = new Map();
  for (const profile of [...canonical, ...legacy]) {
    const key = JSON.stringify([profile.scope, profile.id]);
    const existing = combined.get(key);
    if (existing && !isDeepStrictEqual(existing.credential, profile.credential)) throw new Error("Conflicting saved credentials share a profile ID; refusing to discard an account");
    combined.set(key, profile);
  }
  return [...combined.values()];
}
function assertCredentialPreservation(before, after, { profileIdMap = new Map(), requireCanonical = false } = {}) {
  const provider = value => value === "openai-codex" ? "openai" : value;
  const profileId = value => value.replace(/^openai-codex:/, "openai:");
  for (const { id, scope, credential } of before) {
    if (credential.oauthRef && (!credential.access || !credential.refresh)) throw new Error("A legacy OAuth credential could not be recovered; refusing to activate an unavailable account");
    const fields = ["type", "key", "keyRef", "token", "tokenRef", "access", "refresh", "idToken", "expires", "accountId", "email"]
      .filter(field => credential[field] !== undefined);
    if (!fields.some(field => ["key", "keyRef", "token", "tokenRef", "access", "refresh"].includes(field))) continue;
    const expectedId = profileIdMap.get(id) || profileId(id);
    const exactId = profileIdMap.has(id) || requireCanonical;
    if (!after.some(candidate =>
      candidate.scope === scope &&
      (exactId ? candidate.id : profileId(candidate.id)) === expectedId &&
      (requireCanonical ? candidate.credential.provider : provider(candidate.credential.provider)) === provider(credential.provider) &&
      fields.every(field => isDeepStrictEqual(credential[field], candidate.credential[field]))
    )) {
      throw new Error("A saved provider credential or account identity did not survive migration; refusing activation");
    }
  }
}
module.exports = { agentDirectories, legacyAuthFiles, canonicalAuthStores, replaceCanonicalAuthStore, readProfiles, assertCredentialPreservation };
