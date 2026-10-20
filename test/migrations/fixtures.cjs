const fs = require("node:fs");
const path = require("node:path");

// Synthetic records in formats written by shipped OpenClaw releases. No real
// credentials, channel connections, or scheduled external actions belong here.
// JSON writer provenance: openclaw/openclaw v2026.4.1 src/cron/store.ts and
// src/infra/voicewake.ts. Workboard shapes follow the v2026.9.7 Doctor tests.
const job = {
  id: "umbrel-migration-reminder", name: "Retained reminder", enabled: false,
  agentId: "main", createdAtMs: 1, updatedAtMs: 2,
  schedule: { kind: "every", everyMs: 3600000, anchorMs: 1 },
  sessionTarget: "main", wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "Remember the retained migration fixture" },
  state: {},
};
const voicewake = { triggers: ["retained voice trigger"], updatedAtMs: 2 };
const sessionId = "bdf932a4-5fe6-43f4-ab85-e3afafbc35bc";
const conversation = ["Keep this conversation through the upgrade.", "The conversation is retained."];
const credential = { type: "api_key", provider: "openai", key: "synthetic-profile-key-not-valid" };
const attachment = {
  id: "attachment-1", cardId: "card-1", createdAt: 2,
  fileName: "retained.txt", byteSize: 2,
};
const workboard = [
  ["workboard.boards", 200, "planning", {
    version: 1, board: { id: "planning", name: "Retained planning", createdAt: 1, updatedAt: 2 },
  }],
  ["workboard.cards", 2000, "card-1", {
    version: 1, card: {
      id: "card-1", title: "Retained card", status: "todo", priority: "normal",
      labels: ["migration"], position: 1000, createdAt: 1, updatedAt: 2,
      metadata: { automation: { boardId: "planning" }, attachments: [attachment] },
    },
  }],
  ["workboard.notify", 2000, "sub-1", {
    version: 1, subscription: { id: "sub-1", boardId: "planning", createdAt: 1, updatedAt: 2 },
  }],
  ["workboard.attachments", 42000, "attachment-1", {
    version: 1, attachment, contentBase64: Buffer.from("ok").toString("base64"),
  }],
];

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function createHome(home) {
  const state = path.join(home, ".openclaw");
  writeJson(path.join(state, "openclaw.json"), {
    gateway: { mode: "local", auth: { mode: "password", password: "synthetic-migration-test-only" } },
    agents: { entries: { main: {} } }, plugins: { enabled: false },
  });
  fs.mkdirSync(path.join(state, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(state, "workspace", "USER.md"), "Keep this user's workspace.\n");
  fs.writeFileSync(path.join(state, ".env"), "OPENAI_API_KEY=synthetic-test-key-not-valid\n", { mode: 0o600 });
  return state;
}

function addLegacy(state, kind) {
  if (kind === "cron") writeJson(path.join(state, "cron/jobs.json"), { version: 1, jobs: [job] });
  else if (kind === "voicewake") writeJson(path.join(state, "settings/voicewake.json"), voicewake);
  else if (kind === "config") {
    const file = path.join(state, "openclaw.json");
    writeJson(file, { ...JSON.parse(fs.readFileSync(file)), heartbeat: { every: "37m" } });
  } else throw new Error(`Unknown legacy fixture: ${kind}`);
}

function addHistoryAndCredentials(state) {
  const now = Date.now(), timestamp = new Date(now).toISOString();
  const sessions = path.join(state, "agents/main/sessions");
  const transcript = path.join(sessions, `${sessionId}.jsonl`);
  writeJson(path.join(sessions, "sessions.json"), {
    "agent:main:main": { sessionId, updatedAt: now, sessionFile: transcript, chatType: "direct", modelProvider: "openai", model: "gpt-4.1-mini" },
  });
  const entries = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: path.join(state, "workspace") },
    { type: "message", id: "retained-user-message", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: conversation[0] }], timestamp: now } },
    { type: "message", id: "retained-assistant-message", parentId: "retained-user-message", timestamp, message: { role: "assistant", content: [{ type: "text", text: conversation[1] }], api: "openai-completions", provider: "openai", model: "gpt-4.1-mini", stopReason: "stop", usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: now } },
  ];
  fs.writeFileSync(transcript, entries.map(e => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  writeJson(path.join(state, "agents/main/agent/auth-profiles.json"), { version: 1, profiles: { "openai:migration-test": credential } });
}

module.exports = { createHome, addLegacy, addHistoryAndCredentials, writeJson, job, voicewake, workboard, sessionId, conversation, credential };
