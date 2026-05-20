import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTEXT_FILE = join(dirname(fileURLToPath(import.meta.url)), "RUNTIME_CONTEXT.md");

function formatContext(text) {
  const lines = text.trim().split(/\r?\n/);
  while (lines.length > 0 && !lines[0].trim()) {
    lines.shift();
  }
  if (lines.length > 0 && lines[0].startsWith("# ")) {
    lines[0] = lines[0].replace(/^#\s+/, "").replace(/:$/, "");
    while (lines.length > 1 && !lines[1].trim()) {
      lines.splice(1, 1);
    }
  }
  if (lines.length > 0) {
    lines[0] = `${lines[0].replace(/:$/, "")}:`;
  }
  return lines.join("\n").trim();
}

function loadRuntimeContext() {
  const text = readFileSync(CONTEXT_FILE, "utf8").trim();
  if (!text) {
    throw new Error(`${CONTEXT_FILE} is empty`);
  }
  return formatContext(text);
}

export default {
  id: "umbrel-runtime",
  name: "Umbrel Runtime",
  description: "Injects compact Umbrel runtime context for OpenClaw on umbrelOS.",
  register(api) {
    api.on("before_prompt_build", () => ({
      prependSystemContext: loadRuntimeContext(),
    }));
  },
};
