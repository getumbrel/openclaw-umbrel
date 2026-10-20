const { test } = require("node:test");
const assert = require("node:assert/strict");
const { assertCredentialPreservation } = require("../upgrade-auth.cjs");
const original = { id: "openai-codex:personal", credential: { type: "oauth", provider: "openai-codex", access: "synthetic-access", refresh: "synthetic-refresh", accountId: "account-a", expires: 12345 } };
test("credential verification permits the documented provider rename while preserving profile and account", () => {
  assertCredentialPreservation([original], [{ ...original, id: "openai:personal", credential: { ...original.credential, provider: "openai" } }]);
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
