const fs = require("node:fs");
const path = require("node:path");
const { createHash, createCipheriv } = require("node:crypto");
const { writeJson } = require("./fixtures.cjs");

// Historical writer format: OpenClaw v2026.6.1
// src/commands/doctor-auth-oauth-sidecar.test.ts and
// src/commands/doctor/shared/legacy-oauth-sidecar.ts. The production path uses
// upstream's independent decoder, never this fixture implementation.
const profileId = "openai-codex:migration-test";
const ref = { source: "openclaw-credentials", provider: "openai-codex", id: "0123456789abcdef0123456789abcdef" };
const material = { access: "synthetic-oauth-access", refresh: "synthetic-oauth-refresh", idToken: "synthetic-id-token" };
const metadata = { type: "oauth", provider: ref.provider, expires: 4102444800000, accountId: "synthetic-account-id", email: "fixture@example.invalid" };
function addOAuth(home, state, { missingKey = false, envKey = false, tampered = false } = {}) {
  const seed = "synthetic-master-key-not-valid";
  const key = createHash("sha256").update(`openclaw:auth-profile-oauth:${seed}`).digest();
  const iv = Buffer.from("0102030405060708090a0b0c", "hex");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${ref.id}\0${profileId}\0${ref.provider}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(material), "utf8"), cipher.final()]);
  if (tampered) ciphertext[0] ^= 1;
  writeJson(path.join(state, "credentials/auth-profiles", `${ref.id}.json`), {
    version: 1, profileId, provider: ref.provider,
    encrypted: { algorithm: "aes-256-gcm", iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") },
  });
  writeJson(path.join(state, "agents/main/agent/auth-profiles.json"), { version: 1, profiles: { [profileId]: { ...metadata, oauthRef: ref } } });
  if (!missingKey) {
    if (envKey) fs.appendFileSync(path.join(state, ".env"), `OPENCLAW_AUTH_PROFILE_SECRET_KEY="${seed}"\n`);
    else {
      const keyPath = path.join(home, ".config/openclaw/auth-profile-secret-key");
      fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyPath, seed, { mode: 0o600 });
    }
  }
}
module.exports = { addOAuth, profileId, material, metadata };
