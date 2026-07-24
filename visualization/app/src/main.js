import { loadManifest, loadSet } from "./data.js";
import { createWingScene } from "./wing3d.js";

const statusEl = document.getElementById("status");
const canvasWrap = document.getElementById("canvas-wrap");

async function main() {
  try {
    const manifest = await loadManifest("data");
    const firstSet = manifest.sets[0];
    statusEl.textContent = `Loading ${firstSet.id}…`;

    const payload = await loadSet("data", manifest, firstSet.file);

    const quickNote = manifest.quick
      ? " — Phase 0 quick-mode data (schema check only, not scientifically valid)"
      : "";
    statusEl.textContent = `${firstSet.id} · stiffness factor ${firstSet.stiffnessFactor} · axis ${firstSet.axis}${quickNote}`;

    createWingScene(canvasWrap, manifest, payload);
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
    console.error(err);
  }
}

main();
