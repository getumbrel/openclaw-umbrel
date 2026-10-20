const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { UpgradeStorage, DIRECTORY, inventory, sameInventory } = require("../upgrade-storage.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbrel-upgrade-storage-"));
after(() => {
  function writable(directory) {
    fs.chmodSync(directory, 0o700);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) if (item.isDirectory()) writable(path.join(directory, item.name));
  }
  writable(root);
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(name, options) {
  const home = path.join(root, name), state = path.join(home, ".openclaw");
  fs.mkdirSync(path.join(state, "state"), { recursive: true });
  fs.chmodSync(state, 0o700);
  fs.writeFileSync(path.join(state, "openclaw.json"), '{"wizard":{"lastRunVersion":"old"}}');
  fs.writeFileSync(path.join(state, ".env"), "SYNTHETIC_SECRET=not-a-real-key\n", { mode: 0o600 });
  fs.writeFileSync(path.join(state, "state/openclaw.sqlite-wal"), "synthetic WAL bytes");
  fs.mkdirSync(path.join(home, "custom-workspace"));
  fs.writeFileSync(path.join(home, "custom-workspace/MEMORY.md"), "keep this memory");
  fs.symlinkSync("../custom-workspace", path.join(state, "workspace"));
  return { home, state, storage: new UpgradeStorage(home, state, options) };
}
test("complete snapshot and restoration preserve secrets, WAL, custom workspaces and symlink bytes", () => {
  const { home, state, storage } = fixture("restore");
  const before = inventory(home, { exclude: [DIRECTORY] });
  const workspaceInode = fs.statSync(path.join(home, "custom-workspace")).ino;
  const journal = storage.snapshot("2026.10.5");
  storage.write(journal, "migrating");
  fs.writeFileSync(path.join(state, ".env"), "changed");
  fs.writeFileSync(path.join(home, "custom-workspace/MEMORY.md"), "changed");
  fs.unlinkSync(path.join(state, "state/openclaw.sqlite-wal"));
  fs.writeFileSync(path.join(home, "new-file"), "created by failed migration");
  storage.restore(journal);
  sameInventory(inventory(home, { exclude: [DIRECTORY] }), before);
  assert.equal(storage.read().phase, "failed");
  assert.equal(fs.statSync(path.join(home, "custom-workspace")).ino, workspaceInode, "restore preserves directories that may have another bind mount");
  assert.equal(fs.statSync(path.join(state, ".env")).mode & 0o777, 0o600);
});
test("insufficient space fails before changing user files", () => {
  const { home, storage } = fixture("space", { availableBytes: () => 0 });
  const before = inventory(home, { exclude: [DIRECTORY] });
  assert.throws(() => storage.snapshot("2026.10.5"), /Not enough free space/);
  sameInventory(inventory(home, { exclude: [DIRECTORY] }), before);
  assert.equal(storage.read(), null);
});
test("damaged backup refuses restoration and preserves the current working state", () => {
  const { home, state, storage } = fixture("corrupt");
  const journal = storage.snapshot("2026.10.5");
  fs.writeFileSync(path.join(storage.directory(journal), "original/.openclaw/.env"), "corrupt");
  fs.writeFileSync(path.join(state, ".env"), "current working bytes");
  const before = inventory(home, { exclude: [DIRECTORY] });
  assert.throws(() => storage.restore(journal), /Snapshot verification failed/);
  sameInventory(inventory(home, { exclude: [DIRECTORY] }), before);
});
test("a partially restored home can be restored again from its immutable original", () => {
  const { home, state, storage } = fixture("interruption");
  const before = inventory(home, { exclude: [DIRECTORY] });
  const journal = storage.snapshot("2026.10.5");
  storage.write(journal, "restoring");
  fs.rmSync(state, { recursive: true });
  fs.writeFileSync(path.join(home, "custom-workspace/MEMORY.md"), "partial restore");
  storage.restore(storage.read());
  sameInventory(inventory(home, { exclude: [DIRECTORY] }), before);
});
test("does not follow backup-directory symlinks", () => {
  const { home } = fixture("boundaries");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.rmSync(path.join(home, DIRECTORY), { recursive: true });
  fs.symlinkSync(outside, path.join(home, DIRECTORY));
  assert.throws(() => new UpgradeStorage(home, path.join(home, ".openclaw")), /real directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test("snapshot and restoration retain read-only directory modes without blocking recovery", () => {
  const { home, storage } = fixture("read-only");
  const directory = path.join(home, "custom-workspace");
  fs.chmodSync(directory, 0o555);
  const before = inventory(home, { exclude: [DIRECTORY] });
  const journal = storage.snapshot("2026.10.5");
  fs.writeFileSync(path.join(directory, "MEMORY.md"), "changed");
  storage.restore(journal);
  sameInventory(inventory(home, { exclude: [DIRECTORY] }), before);
});
test("a live IPC file prevents an incomplete snapshot from being accepted", () => {
  const { home, storage } = fixture("special-file");
  require("node:child_process").execFileSync("mkfifo", [path.join(home, "live-pipe")]);
  assert.throws(() => storage.snapshot("2026.10.5"), /special file/);
  assert.equal(storage.read(), null);
});
test("a second live owner cannot take the migration lock", () => {
  const { storage } = fixture("locking");
  const release = storage.lock();
  assert.throws(() => storage.lock(), /still running/);
  release();
  storage.lock()();
});
