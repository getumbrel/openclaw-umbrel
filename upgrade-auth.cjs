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
function assertCredentialPreservation(before, after) {
  const provider = value => value === "openai-codex" ? "openai" : value;
  const profileId = value => value.replace(/^openai-codex:/, "openai:");
  for (const { id, scope, credential } of before) {
    if (credential.oauthRef && (!credential.access || !credential.refresh)) throw new Error("A legacy OAuth credential could not be recovered; refusing to activate an unavailable account");
    const fields = ["type", "key", "keyRef", "token", "tokenRef", "access", "refresh", "idToken", "expires", "accountId", "email"]
      .filter(field => credential[field] !== undefined);
    if (!fields.some(field => ["key", "keyRef", "token", "tokenRef", "access", "refresh"].includes(field))) continue;
    if (!after.some(candidate => candidate.scope === scope && profileId(candidate.id) === profileId(id) && provider(candidate.credential.provider) === provider(credential.provider) && fields.every(field => isDeepStrictEqual(credential[field], candidate.credential[field])))) {
      throw new Error("A saved provider credential or account identity did not survive migration; refusing activation");
    }
  }
}
module.exports = { agentDirectories, legacyAuthFiles, readProfiles, assertCredentialPreservation };
