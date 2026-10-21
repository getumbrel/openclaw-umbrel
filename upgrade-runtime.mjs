// Small adapters to the exact, image-pinned upstream packages. No schema guards
// are patched and no old runtime is allowed to open a newer database.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { legacyAuthFiles, canonicalAuthStores, replaceCanonicalAuthStore } from "./upgrade-auth.cjs";
import { schemaInventory } from "./upgrade.cjs";
import { inside, writeJson } from "./upgrade-storage.cjs";

async function upstreamExport(root, name) {
  const directory = path.join(root, "dist");
  const pattern = new RegExp(`(?:^|,)\\s*${name}(?:\\s+as\\s+([A-Za-z_$][\\w$]*))?\\s*(?=,|$)`);
  for (const file of fs.readdirSync(directory).sort()) {
    if (!file.endsWith(".mjs")) continue;
    const source = fs.readFileSync(path.join(directory, file), "utf8");
    const match = [...source.matchAll(/export\s*\{([^}]+)\}/g)].map(block => block[1].match(pattern)).find(Boolean);
    if (match) {
      const module = await import(pathToFileURL(path.join(directory, file)));
      const exported = match[1] || name;
      if (typeof module[exported] !== "function") throw new Error(`Missing upstream function ${name}`);
      return module[exported];
    }
  }
  throw new Error(`Pinned package does not export ${name}`);
}
function containsInclude(value) {
  return value && typeof value === "object" && (Object.hasOwn(value, "$include") || Object.values(value).some(containsInclude));
}

const [operation, root, resultPath] = process.argv.slice(2);
const require = createRequire(path.join(root, "package.json"));
const JSON5 = require("json5");
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const config = JSON5.parse(fs.readFileSync(configPath, "utf8"));
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort(new Error("Upgrade validation interrupted")));
process.once("SIGINT", () => controller.abort(new Error("Upgrade validation interrupted")));

if (operation === "oauth") {
  if (JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version !== "2026.9.7") throw new Error("OAuth bridge version changed");
  const references = [];
  // Enumerating profiles through the old package also reads its agent-deletion
  // journal. Give it a separate home containing ONLY credential JSON and keys,
  // never the current databases. Candidate Doctor owns all database imports.
  const stores = [
    ...legacyAuthFiles(process.env.OPENCLAW_STATE_DIR, config).map(file => ({ kind: "json", file, raw: JSON.parse(fs.readFileSync(file, "utf8")) })),
    ...canonicalAuthStores(process.env.OPENCLAW_STATE_DIR, schemaInventory(process.env.OPENCLAW_STATE_DIR, config, process.env.HOME).databases),
  ];
  for (const store of stores) {
    const { raw } = store;
    for (const [profileId, profile] of Object.entries(raw.profiles || {})) {
      if (profile?.type !== "oauth" || !profile.oauthRef) continue;
      const ref = profile.oauthRef;
      if (ref.source !== "openclaw-credentials" || ref.provider !== "openai-codex" || profile.provider !== ref.provider || !/^[a-f0-9]{32}$/.test(ref.id)) throw new Error("Unrecognized legacy OAuth reference");
      if (profile.access || profile.refresh || profile.idToken) throw new Error("Both inline and sidecar OAuth credentials exist; refusing to choose an account secret");
      references.push({ store, profileId, ref });
    }
  }
  if (references.length) {
    const sourceEnv = { ...process.env };
    const scratch = fs.mkdtempSync(path.join(path.dirname(resultPath), "oauth-scratch-"));
    try {
      const state = path.join(scratch, ".openclaw"), oauth = path.join(state, "credentials");
      const pending = [...new Set(references.map(item => item.store))];
      const mappings = pending.map((store, index) => ({ store, id: `migration${index}`, copy: path.join(state, `agents/migration${index}/agent/auth-profiles.json`) }));
      for (const item of mappings) {
        fs.mkdirSync(path.dirname(item.copy), { recursive: true, mode: 0o700 });
        writeJson(item.copy, item.store.raw);
      }
      fs.mkdirSync(path.join(oauth, "auth-profiles"), { recursive: true, mode: 0o700 });
      for (const { ref } of references) {
        const source = path.join(sourceEnv.OPENCLAW_OAUTH_DIR || path.join(sourceEnv.OPENCLAW_STATE_DIR, "credentials"), "auth-profiles", `${ref.id}.json`);
        if (!fs.existsSync(source)) throw new Error("Legacy OAuth sidecar is missing");
        fs.copyFileSync(source, path.join(oauth, "auth-profiles", `${ref.id}.json`));
      }
      // Preserve upstream's Linux key-file selection, including the historical
      // fallback when XDG_CONFIG_HOME lies inside the state directory.
      const keySource = [path.join(sourceEnv.XDG_CONFIG_HOME || path.join(sourceEnv.HOME, ".config"), "openclaw/auth-profile-secret-key"), path.join(sourceEnv.HOME, ".openclaw-auth-profile-secrets/auth-profile-secret-key")]
        .find(file => !inside(sourceEnv.OPENCLAW_STATE_DIR, file));
      if (keySource && fs.existsSync(keySource)) {
        if (!inside(sourceEnv.HOME, fs.realpathSync(keySource))) throw new Error("OAuth key is outside the recoverable persistent home");
        const keyCopy = path.join(scratch, ".config/openclaw/auth-profile-secret-key");
        fs.mkdirSync(path.dirname(keyCopy), { recursive: true, mode: 0o700 });
        fs.copyFileSync(keySource, keyCopy);
      }
      Object.assign(process.env, { HOME: scratch, OPENCLAW_STATE_DIR: state, OPENCLAW_OAUTH_DIR: oauth, OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"), XDG_CONFIG_HOME: path.join(scratch, ".config"), XDG_DATA_HOME: path.join(scratch, ".local/share"), XDG_STATE_HOME: path.join(scratch, ".local/state"), XDG_CACHE_HOME: path.join(scratch, ".cache") });
      const cfg = { agents: { entries: Object.fromEntries(mappings.map(item => [item.id, { agentDir: path.dirname(item.copy) }])) } };
      writeJson(process.env.OPENCLAW_CONFIG_PATH, cfg);
      const repair = await upstreamExport(root, "maybeRepairLegacyOAuthSidecarProfiles");
      await repair({ cfg, env: process.env, emitNotes: false, prompter: { confirmAutoFix: async () => true } });
      // Validate every store before publishing any repaired credential file.
      for (const { store, profileId } of references) {
        const profile = JSON.parse(fs.readFileSync(mappings.find(item => item.store === store).copy, "utf8")).profiles?.[profileId];
        if (profile?.oauthRef || !profile?.access || !profile?.refresh) throw new Error("Legacy OAuth material is missing or cannot be decrypted; original credentials are retained in the verified snapshot");
      }
      for (const item of mappings) {
        const repaired = JSON.parse(fs.readFileSync(item.copy, "utf8"));
        if (item.store.kind === "json") writeJson(fs.realpathSync(item.store.file), repaired);
        else replaceCanonicalAuthStore(item.store, repaired);
      }
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
  // Original encrypted sidecars and keys remain intact, including references
  // from other agents. Only validated repaired JSON is published.
  fs.writeFileSync(resultPath, JSON.stringify({ repaired: references.length }), { mode: 0o600 });
} else if (operation === "auth-map") {
  const collect = await upstreamExport(root, "collectOpenAICodexAuthProfileStoreIdMap");
  const mapping = collect({ cfg: config, env: process.env });
  fs.writeFileSync(resultPath, JSON.stringify({ profileIds: [...mapping] }), { mode: 0o600 });
} else if (operation === "telegram") {
  const parserRoot = process.argv[5];
  if (JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version !== "2026.9.7" || JSON.parse(fs.readFileSync(path.join(parserRoot, "package.json"))).version !== "2026.9.5") throw new Error("Telegram migration packages changed");
  // 9.5 still knows how to parse the retired files. Its detector and entry
  // readers use the filesystem; only the schema-compatible 9.7 executor opens
  // SQLite. Preserve upstream's account scopes, token-rotation comparisons,
  // capacity checks, verification and source archival instead of copying rows.
  const detect = await upstreamExport(parserRoot, "detectTelegramLegacyStateMigrations");
  const execute = await upstreamExport(root, "runLegacyMigrationPlans");
  const params = { cfg: config, env: process.env, stateDir: process.env.OPENCLAW_STATE_DIR };
  const plans = await detect(params);
  for (const plan of plans) {
    if (plan.kind !== "plugin-state-import" || plan.pluginId !== "telegram" || !inside(process.env.HOME, fs.realpathSync(plan.sourcePath))) throw new Error("Unexpected Telegram migration plan");
    plan.stateDir = params.stateDir;
  }
  const result = await execute(plans);
  fs.writeFileSync(resultPath, JSON.stringify({ plans: plans.length, ...result }), { mode: 0o600 });
  if (result.warnings?.length || (await detect(params)).length) throw new Error("Retired Telegram state did not migrate completely; original data will be restored");
} else if (operation === "needs-config") {
  const requiresBridge = await upstreamExport(root, "findRetiredConfigUpgradeRequirement");
  fs.writeFileSync(resultPath, JSON.stringify({ required: Boolean(requiresBridge(config)) }), { mode: 0o600 });
} else if (operation === "config") {
  if (JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version !== "2026.9.5") throw new Error("Configuration bridge version changed");
  if (containsInclude(config) || config.plugins?.installs) {
    // These have authored file/registry ownership; a pure object transform is
    // insufficient. The ordinary Doctor must handle them on a compatible DB.
    fs.writeFileSync(resultPath, JSON.stringify({ deferred: true, changed: false }), { mode: 0o600 });
  } else {
    const migrate = await upstreamExport(root, "applyLegacyDoctorMigrations");
    const result = migrate(config, { pluginContracts: false });
    if (result.warnings?.length) throw new Error("Configuration-only bridge needs operator review");
    fs.writeFileSync(resultPath, JSON.stringify({ changed: Boolean(result.next), config: result.next || config, changes: result.changes }), { mode: 0o600 });
  }
} else if (operation === "canary") {
  const validate = await upstreamExport(root, "validateUpdateCandidateCanary");
  const result = await validate({
    root, config, stateDir: process.env.OPENCLAW_STATE_DIR, env: process.env,
    signal: controller.signal,
    nodeRunner: process.execPath, migrationPolicy: "startup-only", timeoutMs: 180_000,
    onProgress: step => console.log(`Upgrade validation: ${step.step} ${step.status}`),
  });
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  // Upstream can return an advisory success without proving readiness. Umbrel
  // requires the actual ready Gateway step and rejects all failure facts.
  const startup = result.steps?.find(step => step.name === "candidate-gateway-startup");
  if (result.status !== "ok" || startup?.exitCode !== 0 || startup.advisory || result.steps.some(step => step.failureFacts?.length)) {
    throw new Error("The migrated Gateway did not pass isolated startup and readiness validation");
  }
} else throw new Error(`Unknown upgrade operation: ${operation}`);
