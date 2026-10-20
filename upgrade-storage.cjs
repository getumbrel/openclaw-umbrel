const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const DIRECTORY = ".umbrel-upgrades";
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeJson(file, value) {
  const pending = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(pending, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(pending, file);
  syncDirectory(path.dirname(file));
}
function digest(file) {
  const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try { let length; while ((length = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, length)); }
  finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
function inventory(root, { exclude = [] } = {}) {
  const entries = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), relative = path.relative(root, file);
      if (exclude.includes(relative)) continue;
      const stat = fs.lstatSync(file);
      const entry = { path: relative, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
      if (stat.isSymbolicLink()) entries.push({ ...entry, type: "link", target: fs.readlinkSync(file) });
      else if (stat.isDirectory()) { entries.push({ ...entry, type: "directory" }); walk(file); }
      else if (stat.isFile()) entries.push({ ...entry, type: "file", size: stat.size, sha256: digest(file) });
      else throw new Error(`Cannot snapshot special file: ${relative}`);
    }
  }
  walk(root);
  return entries;
}
function sameInventory(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const index = expected.findIndex((entry, i) => JSON.stringify(entry) !== JSON.stringify(actual[i]));
    const entry = expected[index] || actual[expected.length];
    throw new Error(`Snapshot verification failed: files changed or the copy is incomplete (${entry?.path || "inventory"})`);
  }
}
function copyTree(source, destination, { exclude = [] } = {}) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    if (!exclude.includes(name)) fs.cpSync(path.join(source, name), path.join(destination, name), {
      recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true,
    });
  }
  function permissions(from, to) {
    const stat = fs.lstatSync(from);
    const copied = fs.lstatSync(to);
    if (stat.uid !== copied.uid || stat.gid !== copied.gid) fs.lchownSync(to, stat.uid, stat.gid);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(from)) permissions(path.join(from, name), path.join(to, name));
    }
    fs.chmodSync(to, stat.mode & 0o7777);
  }
  // fs.cp does not preserve directory modes on Linux. Restore them explicitly
  // before verification; credential directories must not become world-readable.
  for (const name of fs.readdirSync(source)) {
    if (!exclude.includes(name)) permissions(path.join(source, name), path.join(destination, name));
  }
}
function syncTree(root) {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) syncTree(file);
    else if (item.isFile()) {
      const fd = fs.openSync(file, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  syncDirectory(root);
}
function removeIncompleteCopy(directory) {
  // Only used on this transaction's unverified private copy, never user files
  // or a verified original. Restore copied read-only directory modes enough to
  // remove the partial tree without following symlinks.
  if (!fs.existsSync(directory)) return;
  function writable(file) {
    if (!fs.lstatSync(file).isDirectory()) return;
    fs.chmodSync(file, 0o700);
    for (const name of fs.readdirSync(file)) writable(path.join(file, name));
  }
  writable(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}
function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  } catch (error) {
    if (process.platform === "linux") {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try { process.kill(pid, 0); return `${os.hostname()}:${pid}`; }
    catch (e) { if (e.code === "ESRCH") return null; throw e; }
  }
}
function acquireLock(root) {
  const lock = path.join(root, "lock.json");
  const owner = { pid: process.pid, identity: processIdentity(process.pid), token: crypto.randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      syncDirectory(root);
      return () => {
        if (JSON.parse(fs.readFileSync(lock, "utf8")).token !== owner.token) throw new Error("Upgrade lock ownership changed");
        fs.unlinkSync(lock); syncDirectory(root);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = JSON.parse(fs.readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(previous.pid) || typeof previous.identity !== "string") throw new Error("Invalid upgrade lock; refusing to guess its owner");
      if (processIdentity(previous.pid) === previous.identity) throw new Error("Another upgrade process is still running");
      fs.unlinkSync(lock);
    }
  }
  throw new Error("Could not acquire the upgrade lock");
}

class UpgradeStorage {
  constructor(home, stateDir, { reserveBytes = 256 * 1024 * 1024, availableBytes } = {}) {
    this.home = fs.realpathSync(home);
    const logicalHome = path.resolve(home);
    this.stateDir = inside(logicalHome, path.resolve(stateDir))
      ? path.join(this.home, path.relative(logicalHome, path.resolve(stateDir)))
      : path.resolve(stateDir);
    if (!inside(this.home, this.stateDir) || this.stateDir === this.home) throw new Error("OpenClaw state must be inside the persistent home for a recoverable upgrade");
    this.root = path.join(this.home, DIRECTORY);
    if (inside(this.root, this.stateDir)) throw new Error("State cannot use the upgrade backup directory");
    if (fs.existsSync(this.root) && !fs.lstatSync(this.root).isDirectory()) throw new Error("Upgrade directory must be a real directory");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.root, 0o700);
    syncDirectory(this.home);
    this.reserveBytes = reserveBytes;
    this.availableBytes = availableBytes || (() => { const stat = fs.statfsSync(this.home); return stat.bavail * stat.bsize; });
    this.journalPath = path.join(this.root, "journal.json");
  }
  lock() { return acquireLock(this.root); }
  read() {
    if (!fs.existsSync(this.journalPath)) return null;
    const journal = JSON.parse(fs.readFileSync(this.journalPath, "utf8"));
    if (journal.format !== 1 || journal.home !== this.home || journal.stateDir !== this.stateDir || !/^[a-f0-9-]{36}$/.test(journal.id) || !["snapshotting", "prepared", "migrating", "validating", "restoring", "failed", "committed"].includes(journal.phase)) {
      throw new Error("Invalid upgrade journal; retained data requires inspection");
    }
    return journal;
  }
  write(journal, phase, extra = {}) {
    Object.assign(journal, extra, { phase, updatedAt: new Date().toISOString() });
    writeJson(this.journalPath, journal);
  }
  directory(journal) { return path.join(this.root, journal.id); }
  discardIncomplete(journal) {
    if (journal.snapshotReady || !["snapshotting", "failed"].includes(journal.phase)) throw new Error("Refusing to discard a verified or active upgrade snapshot");
    this.write(journal, "failed", { restored: false });
    removeIncompleteCopy(this.directory(journal));
    syncDirectory(this.root);
  }
  snapshot(target) {
    const entries = inventory(this.home, { exclude: [DIRECTORY] });
    const bytes = entries.reduce((total, entry) => total + (entry.size || 0), 0);
    // Keep room for both the retained snapshot and a verified restoration copy.
    if (this.availableBytes() < bytes * 2 + this.reserveBytes) throw new Error("Not enough free space for a verified upgrade backup and recovery copy");
    const journal = { format: 1, id: crypto.randomUUID(), home: this.home, stateDir: this.stateDir, target, createdAt: new Date().toISOString(), snapshotReady: false };
    fs.mkdirSync(this.directory(journal), { mode: 0o700 });
    this.write(journal, "snapshotting");
    const snapshot = path.join(this.directory(journal), "original");
    try {
      copyTree(this.home, snapshot, { exclude: [DIRECTORY] });
      sameInventory(inventory(snapshot), entries);
      sameInventory(inventory(this.home, { exclude: [DIRECTORY] }), entries);
      syncTree(snapshot);
      writeJson(path.join(this.directory(journal), "manifest.json"), entries);
      this.write(journal, "prepared", { snapshotReady: true, bytes });
      return journal;
    } catch (error) {
      // An incomplete copy must not consume the space needed for a later retry.
      // A snapshot that has reached verification is always retained.
      if (!journal.snapshotReady) this.discardIncomplete(journal);
      throw error;
    }
  }
  restore(journal) {
    if (!journal.snapshotReady) throw new Error("No verified snapshot is available; refusing restoration");
    const directory = this.directory(journal), original = path.join(directory, "original");
    const expected = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    sameInventory(inventory(original), expected);
    const restore = path.join(directory, "restore");
    fs.rmSync(restore, { recursive: true, force: true });
    copyTree(original, restore);
    sameInventory(inventory(restore), expected);
    syncTree(restore);
    this.write(journal, "restoring");
    // The immutable original and manifest remain available across every rename.
    // If interrupted here, the next wrapper startup repeats this restoration.
    function publish(source, destination, top = false) {
      // A previous interrupted publication or a user-owned read-only directory
      // may otherwise prevent renames. The parent restores each original mode.
      if (!top) {
        fs.chmodSync(source, fs.statSync(source).mode | 0o700);
        fs.chmodSync(destination, fs.statSync(destination).mode | 0o700);
      }
      const names = fs.readdirSync(source);
      for (const name of fs.readdirSync(destination)) {
        if ((!top || name !== DIRECTORY) && !names.includes(name)) fs.rmSync(path.join(destination, name), { recursive: true, force: true });
      }
      for (const name of names) {
        const from = path.join(source, name), to = path.join(destination, name);
        const sourceStat = fs.lstatSync(from);
        let current;
        try { current = fs.lstatSync(to); } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (sourceStat.isDirectory() && current?.isDirectory()) {
          // /data/linuxbrew is also bind-mounted at /home/linuxbrew. Preserve
          // directory inodes so recovery cannot strand that second mount.
          publish(from, to);
          fs.chmodSync(to, sourceStat.mode & 0o7777);
          const restored = fs.statSync(to);
          if (restored.uid !== sourceStat.uid || restored.gid !== sourceStat.gid) fs.chownSync(to, sourceStat.uid, sourceStat.gid);
        } else {
          fs.rmSync(to, { recursive: true, force: true });
          fs.renameSync(from, to);
        }
      }
      syncDirectory(destination);
    }
    publish(restore, this.home, true);
    syncDirectory(this.home);
    sameInventory(inventory(this.home, { exclude: [DIRECTORY] }), expected);
    this.write(journal, "failed", { restored: true });
  }
}

module.exports = { UpgradeStorage, DIRECTORY, inside, inventory, sameInventory, writeJson, processIdentity };
