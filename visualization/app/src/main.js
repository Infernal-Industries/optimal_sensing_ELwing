import { loadManifest, loadSet } from "./data.js";
import { createWingScene } from "./wing3d.js";
import { createTimelines } from "./timelines.js";
import { createWing2D } from "./wing2d.js";
import { createHistogram } from "./histogram.js";
import { computePFire } from "./encoding.js";

const statusEl = document.getElementById("status");
const canvasWrap = document.getElementById("canvas-wrap");
const timelinesWrap = document.getElementById("timelines-wrap");
const wing2dCanvases = document.getElementById("wing2d-canvases");
const histogramWrap = document.getElementById("histogram-wrap");
const colorModeSelect = document.getElementById("color-mode");
const betaSlider = document.getElementById("beta-slider");
const betaValueEl = document.getElementById("beta-value");

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

    const timelines = createTimelines(timelinesWrap, manifest, payload, computePFire);

    const wing2d = createWing2D(wing2dCanvases, manifest, payload, {
      onSelectSensor: (sensorIdx1) => timelines.setSensor(sensorIdx1 - 1),
    });

    const wing = createWingScene(canvasWrap, manifest, payload, {
      onFrame: (frameIdx, timeMs) => {
        timelines.setPlayhead(timeMs);
        const strainFrameIdx = Math.floor((frameIdx * payload.strainFrames) / payload.frames);
        wing2d.setFrame(strainFrameIdx);
      },
    });

    colorModeSelect.addEventListener("change", () => {
      wing.setColorMode(colorModeSelect.value);
      wing2d.setColorMode(colorModeSelect.value);
    });

    betaSlider.value = manifest.encoding.nldShift;
    betaValueEl.textContent = Number(betaSlider.value).toFixed(2);
    betaSlider.addEventListener("input", () => {
      const nldShift = Number(betaSlider.value);
      betaValueEl.textContent = nldShift.toFixed(2);
      wing.setThreshold(manifest.encoding.nldGrad, nldShift);
      timelines.setThreshold(manifest.encoding.nldGrad, nldShift);
      wing2d.setThreshold(manifest.encoding.nldGrad, nldShift);
    });

    // Histogram compares spanwise sensor distribution across ALL available
    // precomputed sets (currently 2; grows with Phase 5's full grid) --
    // independent of which set the 3D/2D/timeline views are showing.
    const allSetPayloads = await Promise.all(
      manifest.sets.map((s) => (s === firstSet ? Promise.resolve(payload) : loadSet("data", manifest, s.file)))
    );
    createHistogram(
      histogramWrap,
      manifest,
      manifest.sets.map((s, i) => ({
        id: s.id,
        stiffnessFactor: s.stiffnessFactor,
        spanHistogram: allSetPayloads[i].spanHistogram,
      }))
    );
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
    console.error(err);
  }
}

main();
