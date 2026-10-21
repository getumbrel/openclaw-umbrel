// Seed canonical offsets through the shipped 9.8 SDK, before upgrading retained
// older JSON. A stale file must never rewind a bot or overwrite another account.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
const { createPluginStateKeyedStore } = await import(pathToFileURL(path.join(root, "dist/plugin-sdk/plugin-state-store-runtime.js")));
const store = createPluginStateKeyedStore("telegram", { namespace: "telegram.update-offsets", maxEntries: 1000, env: process.env });
await store.register("default", { version: 1, lastUpdateId: 23456, botId: null, tokenFingerprint: null });
await store.register("second", { version: 3, lastUpdateId: 45678, botId: "22222", tokenFingerprint: "synthetic-second-bot" });
fs.writeSync(1, "Canonical Telegram offsets seeded\n");
process.exit(0);
