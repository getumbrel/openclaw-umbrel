const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { assertCredentialPreservation, canonicalAuthStores, replaceCanonicalAuthStore } = require("../upgrade-auth.cjs");
const original = { id: "openai-codex:personal", credential: { type: "oauth", provider: "openai-codex", access: "synthetic-access", refresh: "synthetic-refresh", accountId: "account-a", expires: 12345 } };
test("credential verification permits the documented provider rename while preserving profile and account", () => {
  assertCredentialPreservation([original], [{ ...original, id: "openai:personal", credential: { ...original.credential, provider: "openai" } }]);
  assert.throws(() => assertCredentialPreservation([original], [original], { requireCanonical: true }), /did not survive/);
});
test("successful Doctor output cannot mask lost credentials, profile routing, or account identity", () => {
  for (const credential of [
    { ...original.credential, refresh: undefined },
    { ...original.credential, accountId: "account-b" },
    { ...original.credential, access: "rotated-before-commit" },
  ]) assert.throws(() => assertCredentialPreservation([original], [{ ...original, credential }]), /did not survive/);
  assert.throws(() => assertCredentialPreservation([original], [{ ...original, id: "openai:work" }]), /did not survive/);
});
test("reference-only OAuth credentials are refused even if the unavailable profile was copied exactly", () => {
  const unresolved = { id: "openai:personal", credential: { type: "oauth", provider: "openai", oauthRef: { id: "missing" } } };
  assert.throws(() => assertCredentialPreservation([unresolved], [unresolved]), /could not be recovered/);
});
test("credentials must remain assigned to the same agent even when profile IDs match", () => {
  const shared = { ...original, scope: "shared" };
  const separate = { ...original, scope: "/data/custom-agent", credential: { ...original.credential, access: "second-account", refresh: "second-refresh" } };
  assertCredentialPreservation([shared, separate], [shared, separate]);
  assert.throws(() => assertCredentialPreservation([shared, separate], [shared, { ...separate, scope: "shared" }]), /did not survive/);
});
test("only the planned collision rename is accepted, with the same secret and agent", () => {
  const options = { profileIdMap: new Map([[original.id, "openai:chatgpt-personal"]]) };
  const renamed = { ...original, id: "openai:chatgpt-personal", credential: { ...original.credential, provider: "openai" } };
  assertCredentialPreservation([original], [renamed], options);
  assert.throws(() => assertCredentialPreservation([original], [renamed]), /did not survive/);
  assert.throws(() => assertCredentialPreservation([original], [{ ...renamed, id: "openai:work" }], options), /did not survive/);
  assert.throws(() => assertCredentialPreservation([original], [{ ...renamed, scope: "different-agent" }], options), /did not survive/);
  assert.throws(() => assertCredentialPreservation([original], [{ ...renamed, credential: { ...renamed.credential, refresh: "another-account" } }], options), /did not survive/);
});
test("canonical OAuth repair preserves store ownership and metadata and refuses concurrent changes", t => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "umbrel-auth-stores-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const shared = path.join(state, "shared.sqlite"), agent = path.join(state, "agent.sqlite");
  const db = new DatabaseSync(shared), agentDb = new DatabaseSync(agent);
  t.after(() => { db.close(); agentDb.close(); });
  db.exec("CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT,updated_at_ms INTEGER); PRAGMA user_version=19");
  agentDb.exec("CREATE TABLE auth_profile_store(store_key TEXT PRIMARY KEY,store_json TEXT,updated_at_ms INTEGER); PRAGMA user_version=24");
  const raw = { version: 1, profiles: { personal: { type: "oauth", oauthRef: { id: "synthetic" } } }, order: { openai: ["personal"] } };
  db.prepare("INSERT INTO config_machine_state VALUES ('authProfiles.store',?,123)").run(JSON.stringify(raw));
  agentDb.prepare("INSERT INTO auth_profile_store VALUES ('primary',?,456)").run(JSON.stringify(raw));
  const stores = canonicalAuthStores(state, [{ path: "shared.sqlite", kind: "state" }, { path: "agent.sqlite", kind: "agent" }]);
  assert.equal(stores.length, 2);
  const repaired = { ...raw, profiles: { personal: original.credential } };
  for (const store of stores) replaceCanonicalAuthStore(store, repaired);
  assert.deepEqual(JSON.parse(db.prepare("SELECT value_json FROM config_machine_state").get().value_json), repaired);
  assert.deepEqual(JSON.parse(agentDb.prepare("SELECT store_json FROM auth_profile_store").get().store_json), repaired);
  assert.equal(db.prepare("SELECT updated_at_ms FROM config_machine_state").get().updated_at_ms, 123);
  assert.equal(agentDb.prepare("SELECT updated_at_ms FROM auth_profile_store").get().updated_at_ms, 456);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 19);
  assert.equal(agentDb.prepare("PRAGMA user_version").get().user_version, 24);
  for (const store of stores) assert.throws(() => replaceCanonicalAuthStore(store, raw), /changed during repair/);
});
