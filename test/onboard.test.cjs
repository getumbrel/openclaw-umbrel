const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

function launch(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-onboard-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, "openclaw.mjs");
  fs.writeFileSync(cli, source, { mode: 0o755 });
  fs.symlinkSync(cli, path.join(dir, "openclaw"));
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    UMBREL_ONBOARD_COMPILE_CACHE: path.join(dir, "cache") };
  delete env.NODE_COMPILE_CACHE;
  const child = spawn(process.execPath, [path.resolve(__dirname, "../onboard.cjs"), "onboard", "--classic"], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

test("waits for prompts and async cleanup, then exits despite leftover handles", { timeout: 5000 }, async (t) => {
  const { child, done } = launch(t, `
    import assert from 'node:assert/strict';
    import module from 'node:module';
    import readline from 'node:readline';
    assert.equal(module.getCompileCacheDir(), undefined);
    assert.ok(process.env.NODE_COMPILE_CACHE.endsWith('/cache'));
    assert.equal(process.env.UMBREL_ONBOARD_COMPILE_CACHE, undefined);
    assert.deepEqual(process.argv.slice(2), ['onboard', '--classic']);
    const prompt = readline.createInterface({ input: process.stdin });
    console.log('PROMPT');
    for await (const line of prompt) {
      assert.equal(line, 'finish');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    console.log('CLEANUP COMPLETE');
    setInterval(() => {}, 1000);
  `);
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => { if (data.toString().includes("PROMPT")) resolve(); });
    child.on("exit", () => reject(new Error("Exited before the prompt")));
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null, "must not end a pending prompt");
  child.stdin.end("finish\n");
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /CLEANUP COMPLETE/);
});

test("preserves an unsuccessful CLI exit code", { timeout: 5000 }, async (t) => {
  const { done } = launch(t, "process.exitCode = 7; setInterval(() => {}, 1000);");
  assert.equal((await done).code, 7);
});

test("reports an asynchronous CLI failure without treating it as completed setup", { timeout: 5000 }, async (t) => {
  const { done } = launch(t, "await Promise.resolve(); throw new Error('test setup failure');");
  const result = await done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /test setup failure/);
});
