// Run onboarding to completion, then exit even if a provider leaves an idle
// connection open. Await the CLI itself so prompts, writes, and cleanup finish
// before the wrapper receives the successful exit and starts the Gateway.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const executable = (process.env.PATH || "").split(path.delimiter)
    .map((directory) => path.join(directory, "openclaw"))
    .find((candidate) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!executable) throw new Error("OpenClaw executable not found on PATH");

  const cli = fs.realpathSync(executable);
  process.argv = [process.execPath, cli, ...process.argv.slice(2)];

  // Node must start without an already-active compile cache. Restoring the
  // directory here lets OpenClaw initialize its own versioned cache in-process,
  // instead of respawning a child whose completion this launcher cannot await.
  if (process.env.UMBREL_ONBOARD_COMPILE_CACHE) {
    process.env.NODE_COMPILE_CACHE = process.env.UMBREL_ONBOARD_COMPILE_CACHE;
  }
  delete process.env.UMBREL_ONBOARD_COMPILE_CACHE;

  await import(pathToFileURL(cli).href);
}

async function finish() {
  const exit = () => process.exit(process.exitCode ?? 0);
  // Preserve the CLI's final output, including when stdout is a pipe. Bound only
  // output draining, never the interactive command or its asynchronous cleanup.
  const fallback = setTimeout(exit, 5000);
  fallback.unref();
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise((resolve) => stream.write("", resolve))));
  clearTimeout(fallback);
  exit();
}

main().catch((error) => {
  console.error("OpenClaw onboarding failed:", error);
  process.exitCode = 1;
}).then(finish);
