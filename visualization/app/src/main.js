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

    const quickNote = manifest.quick
      ? " — Phase 0 quick-mode data (schema check only, not scientifically valid)"
      : "";

    // --- β/α/ω live-threshold state persists across dataset reloads (stiffness/axis
    // switches), so switching sets keeps whatever threshold the user dialed in.
    let nldShift = manifest.encoding.nldShift;
    let nldGrad = manifest.encoding.nldGrad;
    let staFreq = manifest.encoding.staFreq;
    let sensorCount = 10;

    // wing/wing2d/timelines/histogram are reassigned on every dataset (re)load --
    // declared with `let` so closures created below (pushThreshold, the sensor-count
    // control, wing's onFrame callback) always see the current instances, not whichever
    // ones existed at closure-creation time.
    let wing, wing2d, timelines, histogram, currentSet, currentPayload;

    // computePFireAll recomputes P(fire) for all ~1300 sensors x 2 conditions in both
    // wing3d.js and wing2d.js on every call -- fires live on every slider drag frame, but
    // encoding.js caches/dedupes this (see pfireAllCache and the hoisted STA filter
    // build), which brought one full recompute down to ~115ms, fast enough to stay live.
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

    // --- Loads (or reloads, on stiffness/axis change) one precomputed set. Tears down
    // the previous instances first: wing3d.js runs a persistent requestAnimationFrame
    // loop tied to its own WebGL context, so it needs an explicit dispose(); the other
    // three modules have no persistent loop, so clearing their containers is enough.
    async function loadAndMount(setEntry) {
      statusEl.textContent = `Loading ${setEntry.id}…`;
      const payload = await loadSet("data", manifest, setEntry.file);
      currentSet = setEntry;
      currentPayload = payload;

      wing?.dispose();
      canvasWrap.innerHTML = "";
      timelinesWrap.innerHTML = "";
      wing2dCanvases.innerHTML = "";
      histogramWrap.innerHTML = "";

      statusEl.textContent = `${setEntry.id} · stiffness factor ${setEntry.stiffnessFactor} · axis ${setEntry.axis}${quickNote}`;

      timelines = createTimelines(timelinesWrap, manifest, payload, computePFire);
      histogram = createHistogram(histogramWrap, manifest, payload);

      wing2d = createWing2D(wing2dCanvases, manifest, payload, {
        onSelectSensor: (sensorIdx1) => {
          timelines.setSensor(sensorIdx1 - 1);
          histogram.setSensor(sensorIdx1 - 1);
        },
      });

      wing = createWingScene(canvasWrap, manifest, payload, {
        onFrame: (frameIdx, timeMs) => {
          timelines.setPlayhead(timeMs);
          const strainFrameIdx = Math.floor((frameIdx * payload.strainFrames) / payload.frames);
          wing2d.setFrame(strainFrameIdx);
        },
      });

      wing.setColorMode(colorModeSelect.value);
      wing2d.setColorMode(colorModeSelect.value);
      wing.setThreshold(nldGrad, nldShift, staFreq);
      timelines.setThreshold(nldGrad, nldShift, staFreq);
      wing2d.setThreshold(nldGrad, nldShift, staFreq);
      histogram.setThreshold(nldGrad, nldShift, staFreq);
      wing.setSensorCount(sensorCount);
      wing2d.setSensorCount(sensorCount);
      accuracyN.textContent = String(sensorCount);
      accuracyValue.textContent = `${(payload.accuracyBySensorCount[sensorCount - 1] * 100).toFixed(0)}%`;
      updateAccuracyNotice();
    }

    await loadAndMount(firstSet);

    colorModeSelect.addEventListener("change", () => {
      wing.setColorMode(colorModeSelect.value);
      wing2d.setColorMode(colorModeSelect.value);
    });

    // --- Axis: discrete, precomputed only (Plan §7 -- "no interpolation, pick one").
    // Phase 5's Medium grid precomputes all three axes at every stiffness value, so
    // switching axis just reloads the matching precomputed set at the current
    // stiffness factor.
    axisSelect.value = firstSet.axis;
    axisSelect.addEventListener("change", () => {
      const match = manifest.sets.find(
        (s) => s.axis === axisSelect.value && s.stiffnessFactor === currentSet.stiffnessFactor
      );
      if (!match) {
        statusEl.textContent = `"${axisSelect.value}" axis isn't precomputed at stiffness factor ${currentSet.stiffnessFactor} — showing ${currentSet.axis} data. ${quickNote}`;
        axisSelect.value = currentSet.axis;
        return;
      }
      loadAndMount(match);
    });

    // Neural threshold (β) is a genuine independent variable of the paper (title:
    // "wing structure AND neural encoding jointly determine sensing strategies"),
    // co-equal with wing stiffness E -- kept editable. Slope (α) and filter frequency
    // (ω) are secondary shape-parameters of the same encoding model, not headline swept
    // variables in the paper, so they're fixed at the exported defaults (no UI control).
    // Applies immediately on every slider move (like Animation speed/Sensor count
    // below) -- no Apply-button gating needed now that encoding.js's caching brought a
    // full recompute down to ~115ms (see pushThreshold's comment above).
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
    accuracyValue.textContent = `${(currentPayload.accuracyBySensorCount[9] * 100).toFixed(0)}%`;
    createLiveDualControl(paramControls, {
      label: "Sensor count shown",
      min: 1,
      max: 10,
      step: 1,
      value: 10,
      format: (v) => String(Math.round(v)),
      onChange: (v) => {
        sensorCount = Math.round(v);
        wing.setSensorCount(sensorCount);
        wing2d.setSensorCount(sensorCount);
        accuracyN.textContent = String(sensorCount);
        accuracyValue.textContent = `${(currentPayload.accuracyBySensorCount[sensorCount - 1] * 100).toFixed(0)}%`;
      },
    });

    // --- Wing stiffness E: the resolution-ladder case (Plan §7). Phase 5's Medium
    // grid precomputes 10 stiffness values (deduped here -- manifest.sets has one
    // entry per axis, so raw stiffnessFactor values repeat 3x) at the current axis;
    // picking a grid point reloads the matching precomputed set immediately (dragging
    // across notches fires a reload per notch, same as before Apply-gating existed).
    const uniqueStiffness = [...new Set(manifest.sets.map((s) => s.stiffnessFactor))];
    createResolutionLadderControl(paramControls, {
      label: "Wing stiffness factor (E)",
      points: uniqueStiffness,
      value: firstSet.stiffnessFactor,
      floor: STIFFNESS_FLOOR,
      onChange: (v) => {
        const match = manifest.sets.find((s) => s.stiffnessFactor === v && s.axis === currentSet.axis);
        if (!match) {
          statusEl.textContent = `Stiffness factor ${v} isn't precomputed at axis "${currentSet.axis}" — showing the previous set. ${quickNote}`;
          return;
        }
        loadAndMount(match);
      },
    });
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
    console.error(err);
  }
}

main();
