const { ensureUpgrade } = require("./upgrade.cjs");
const { reconcileConfig } = require("./setup-server.cjs");
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
ensureUpgrade({
  home: process.env.HOME,
  stateDir: process.env.OPENCLAW_STATE_DIR,
  retry: process.argv.includes("--retry"),
  externallyLocked: true, // This private entrypoint is exec'd by flock --no-fork.
  signal: controller.signal,
  reconcile: reconcileConfig,
  progress: message => console.log(`OpenClaw upgrade: ${message}`),
}).then(result => console.log(`OpenClaw upgrade checks complete (${result.target})`)).catch(error => {
  console.error(`OpenClaw upgrade stopped: ${error.message}`);
  // The container restart kills every old process namespace member. Recovery
  // is admitted only after PID 1's birth identity has changed.
  process.exitCode = error.interrupted || error.cleanupUncertain || controller.signal.aborted ? 86 : 1;
});
