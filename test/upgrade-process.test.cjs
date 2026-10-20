const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { command } = require("../upgrade.cjs");
test("a successful command cannot leave a detached writer behind between migration runtimes", { skip: process.platform !== "linux" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-descendant-"));
  const pidFile = path.join(home, "child.pid");
  const script = `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore',env:process.env}); fs.writeFileSync(process.argv[1],String(child.pid)); child.unref();`;
  try {
    await assert.rejects(command(["-e", script, pidFile], { env: { ...process.env, HOME: home }, log: path.join(home, "command.log") }), error => error.cleanupUncertain && /left a running descendant/.test(error.message));
  } finally {
    if (fs.existsSync(pidFile)) { try { process.kill(-Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
