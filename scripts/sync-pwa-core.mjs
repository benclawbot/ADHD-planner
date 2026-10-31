import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "sites/tempo-planner/public/src");

// Canonical PWA core files shared byte-for-byte between the standalone root app
// and the hosted Site iframe. Contextual files (serving path, auth model, voice
// asset layout) remain per-platform variants.
const CORE = [
  "index.html",
  "manifest.webmanifest",
  "model.js",
  "planning.js",
  "recurrence.js",
  "subtasks.js",
  "voice-capture.js",
  "voice-worker.js",
];

async function main() {
  let copied = 0;
  for (const file of CORE) {
    await copyFile(join(root, "src", file), join(site, file));
    copied += 1;
  }
  console.log(`Synced ${copied} PWA core files from src/ to sites/tempo-planner/public/src/`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
