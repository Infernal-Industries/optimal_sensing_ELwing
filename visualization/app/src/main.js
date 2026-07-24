import { loadManifest, loadSet } from "./data.js";
import { createWingScene } from "./wing3d.js";
import { createTimelines } from "./timelines.js";
import { createWing2D } from "./wing2d.js";
import { createHistogram } from "./histogram.js";
import { computePFire } from "./encoding.js";
import { createLiveDualControl, createResolutionLadderControl } from "./controls.js";

// Physical floor for wing stiffness (Plan §4/§7): the Euler-Lagrange model
// doesn't converge below ~0.7 GPa; stiffness factor 1 = 3 GPa, so the floor
// in factor units is 0.7/3.
const STIFFNESS_FLOOR = 0.7 / 3;

const statusEl = document.getElementById("status");
const canvasWrap = document.getElementById("canvas-wrap");
const timelinesWrap = document.getElementById("timelines-wrap");
const wing2dCanvases = document.getElementById("wing2d-canvases");
const histogramWrap = document.getElementById("histogram-wrap");
const colorModeSelect = document.getElementById("color-mode");
const axisSelect = document.getElementById("axis-select");
const paramControls = document.getElementById("param-controls");
const accuracyN = document.getElementById("accuracy-n");
const accuracyValue = document.getElementById("accuracy-value");
const accuracyNotice = document.getElementById("accuracy-notice");

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
    const histogram = createHistogram(histogramWrap, manifest, payload);

    const wing2d = createWing2D(wing2dCanvases, manifest, payload, {
      onSelectSensor: (sensorIdx1) => {
        timelines.setSensor(sensorIdx1 - 1);
        histogram.setSensor(sensorIdx1 - 1);
      },
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

    // --- Axis: discrete, precomputed only (Plan §7 -- "no interpolation,
    // pick one"). Only `yaw` is precomputed right now; picking anything
    // else can't load real data (no Tier 2 backend, no other precomputed
    // axis yet) so it snaps back with a notice rather than silently no-op.
    axisSelect.value = firstSet.axis;
    axisSelect.addEventListener("change", () => {
      if (axisSelect.value !== firstSet.axis) {
        statusEl.textContent = `"${axisSelect.value}" axis isn't precomputed yet (only "${firstSet.axis}" is) — showing ${firstSet.axis} data. ${quickNote}`;
        axisSelect.value = firstSet.axis;
      }
    });

    // --- β / α / ω / speed: fully client-computable (Plan §7), so the
    // dual control is unrestricted -- no backend, no resolution ladder,
    // every change recomputes live across all four consumers that derive
    // P(fire) (wing, wing2d, timelines, histogram).
    let nldShift = manifest.encoding.nldShift;
    let nldGrad = manifest.encoding.nldGrad;
    let staFreq = manifest.encoding.staFreq;

    function pushThreshold() {
      wing.setThreshold(nldGrad, nldShift, staFreq);
      timelines.setThreshold(nldGrad, nldShift, staFreq);
      wing2d.setThreshold(nldGrad, nldShift, staFreq);
      histogram.setThreshold(nldGrad, nldShift, staFreq);
      updateAccuracyNotice();
    }

    function updateAccuracyNotice() {
      const isDefault =
        nldGrad === manifest.encoding.nldGrad &&
        nldShift === manifest.encoding.nldShift &&
        staFreq === manifest.encoding.staFreq;
      accuracyNotice.textContent = isDefault
        ? ""
        : `Approximate: the optimal-sensor overlay & this accuracy figure were computed by SSPOC (MATLAB) at β=${manifest.encoding.nldShift}, α=${manifest.encoding.nldGrad}, ω=${manifest.encoding.staFreq} — they don't update with these live β/α/ω controls (that would need re-running SSPOC, a Tier 2 job).`;
    }

    createLiveDualControl(paramControls, {
      label: "Neural threshold (β)",
      min: 0.05,
      max: 0.7,
      step: 0.01,
      value: nldShift,
      onChange: (v) => {
        nldShift = v;
        pushThreshold();
      },
    });
    createLiveDualControl(paramControls, {
      label: "Slope (α)",
      min: 1,
      max: 100,
      step: 1,
      value: nldGrad,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        nldGrad = v;
        pushThreshold();
      },
    });
    createLiveDualControl(paramControls, {
      label: "Filter frequency (ω)",
      min: 0,
      max: 5,
      step: 0.1,
      value: staFreq,
      onChange: (v) => {
        staFreq = v;
        pushThreshold();
      },
    });
    createLiveDualControl(paramControls, {
      label: "Animation speed",
      min: 0.1,
      max: 5,
      step: 0.1,
      value: 1,
      format: (v) => `×${v.toFixed(1)}`,
      onChange: (v) => wing.setSpeed(v),
    });

    // --- Sensor count: bounded by data availability (only top-10 exported),
    // not a resolution ladder -- both bar and text stay 1-10.
    accuracyN.textContent = "10";
    accuracyValue.textContent = `${(payload.accuracyBySensorCount[9] * 100).toFixed(0)}%`;
    createLiveDualControl(paramControls, {
      label: "Sensor count shown",
      min: 1,
      max: 10,
      step: 1,
      value: 10,
      format: (v) => String(Math.round(v)),
      onChange: (v) => {
        const n = Math.round(v);
        wing.setSensorCount(n);
        wing2d.setSensorCount(n);
        accuracyN.textContent = String(n);
        accuracyValue.textContent = `${(payload.accuracyBySensorCount[n - 1] * 100).toFixed(0)}%`;
      },
    });

    // --- Wing stiffness E: the resolution-ladder case (Plan §7). Only one
    // stiffness factor is precomputed right now, so this mostly
    // demonstrates the snap-to-nearest + notify mechanism -- typing
    // anything else has no Tier 2 backend to defer to yet, so it always
    // snaps back to the single available point with an explanatory notice.
    createResolutionLadderControl(paramControls, {
      label: "Wing stiffness factor (E)",
      points: manifest.sets.map((s) => s.stiffnessFactor),
      value: firstSet.stiffnessFactor,
      floor: STIFFNESS_FLOOR,
      onChange: () => {
        // No-op beyond the control's own notice: only one precomputed set
        // exists, so there's nothing further to reload yet (Phase 5+).
      },
    });
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
    console.error(err);
  }
}

main();
