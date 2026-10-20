// Runs in a separate process so each package owns and closes its own SQLite
// connections before another OpenClaw version touches the fixture.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fixtures from "./fixtures.cjs";

const [root, operation] = process.argv.slice(2);
const load = relative => import(pathToFileURL(path.join(root, "dist", relative)).href);
if (operation === "seed") {
  const { createPluginStateKeyedStore } = await load("plugin-sdk/plugin-state-store-runtime.js");
  for (const [namespace, maxEntries, key, value] of fixtures.workboard) {
    await createPluginStateKeyedStore("workboard", { namespace, maxEntries, env: process.env }).register(key, value);
  }
} else if (operation === "verify") {
  // Read canonical tables directly: verification must not run an importer or
  // silently repair missing data through the very SDK under test.
  const state = process.env.OPENCLAW_STATE_DIR;
  const shared = new DatabaseSync(path.join(state, "state/openclaw.sqlite"), { readOnly: true });
  try {
    for (const [namespace] of fixtures.workboard) {
      assert.equal(shared.prepare("SELECT count(*) AS n FROM plugin_state_entries WHERE plugin_id = 'workboard' AND namespace = ?").get(namespace).n, 0, `${namespace} source is settled`);
    }
  } finally { shared.close(); }
  const db = new DatabaseSync(path.join(state, "plugins/workboard/workboard.sqlite"), { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare("SELECT id, name, created_at, updated_at FROM workboard_boards WHERE id = 'planning'").get() }, { id: "planning", name: "Retained planning", created_at: 1, updated_at: 2 });
    assert.deepEqual({ ...db.prepare("SELECT id, board_id, title, status, priority, position FROM workboard_cards WHERE id = 'card-1'").get() }, { id: "card-1", board_id: "planning", title: "Retained card", status: "todo", priority: "normal", position: 1000 });
    assert.deepEqual(db.prepare("SELECT label FROM workboard_card_labels WHERE card_id = 'card-1' ORDER BY ordinal").all().map(r => r.label), ["migration"]);
    assert.deepEqual({ ...db.prepare("SELECT id, board_id, created_at, updated_at FROM workboard_notification_subscriptions WHERE id = 'sub-1'").get() }, { id: "sub-1", board_id: "planning", created_at: 1, updated_at: 2 });
    assert.deepEqual({ ...db.prepare("SELECT id, card_id, file_name, byte_size FROM workboard_card_attachments WHERE id = 'attachment-1'").get() }, { id: "attachment-1", card_id: "card-1", file_name: "retained.txt", byte_size: 2 });
    assert.equal(Buffer.from(db.prepare("SELECT content FROM workboard_attachment_blobs WHERE attachment_id = 'attachment-1'").get().content).toString(), "ok");
  } finally { db.close(); }
} else throw new Error(`Unknown Workboard operation: ${operation}`);

// Published SDK workers can retain their parent IPC handle. Writes above are
// awaited; exit is confined to this disposable fixture helper, never production.
fs.writeSync(1, `Workboard ${operation} complete\n`);
process.exit(0);
