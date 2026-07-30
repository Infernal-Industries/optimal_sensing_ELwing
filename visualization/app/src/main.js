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
const wing2dWrap = document.getElementById("wing2d-wrap");
const panelToggle = document.getElementById("panel-toggle");
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

    // --- Left-panel view state, also hoisted so it survives loadAndMount (which tears
    // down and recreates wing/wing2d on every stiffness/axis change): which panel is
    // shown, and the 3D scene's current per-wing rotation (dragging shouldn't reset to
    // 0,0 just because the user then changed the stiffness slider).
    let show3d = true;
    let yaw = 0;
    let pitch = 0;
    // Also hoisted for the same reason: a stiffness/axis reload must not silently
    // resume playback if the user had paused (e.g. by clicking a chart) beforehand.
    let paused = false;

    // wing/wing2d/timelines/histogram are reassigned on every dataset (re)load --
    // declared with `let` so closures created below (pushThreshold, the sensor-count
    // control, wing's onFrame callback) always see the current instances, not whichever
    // ones existed at closure-creation time.
    let wing, wing2d, timelines, histogram, currentSet, currentPayload;

    // Shared by both the 3D and 2D pickers so clicking the same physical sensor in
    // either view lands on the same selection.
    function selectSensor(sensorIdx1) {
      timelines.setSensor(sensorIdx1 - 1);
      histogram.setSensor(sensorIdx1 - 1);
    }

    // Clicking a point on either Strain/P(fire) chart pauses the animation there
    // (timelines.js already pinned both charts' crosshair/tooltip at `ms` before
    // calling this). playPauseBtn is declared further down (with the other param
    // controls) but this is only ever invoked later, from a real click, by which
    // point it's assigned -- see the `let`/closure pattern already used for
    // wing/timelines/etc. throughout this file.
    function onChartSeek(ms) {
      paused = true;
      wing.setPaused(true);
      wing.seekTo(ms);
      updatePlayButtonLabel();
    }
    function updatePlayButtonLabel() {
      playPauseBtn.textContent = paused ? "▶" : "⏸";
    }

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
      if (isDefault) {
        accuracyNotice.style.display = "none";
        accuracyNotice.title = "";
      } else {
        accuracyNotice.style.display = "inline";
        accuracyNotice.title = `Approximate: the optimal-sensor overlay & this accuracy figure were computed by SSPOC (MATLAB) at β=${manifest.encoding.nldShift}, α=${manifest.encoding.nldGrad}, ω=${manifest.encoding.staFreq} — they don't update with these live β/α/ω controls (that would need re-running SSPOC, a Tier 2 job).`;
      }
    }

    // --- Loads (or reloads, on stiffness/axis change) one precomputed set. Tears down
    // the previous instances first: wing3d.js runs a persistent requestAnimationFrame
    // loop tied to its own WebGL context, so it needs an explicit dispose(); timelines.js
    // and histogram.js now hold a ResizeObserver each and also need disposing; wing2d.js
    // has no persistent resource, clearing its container is enough.
    async function loadAndMount(setEntry) {
      statusEl.textContent = `Loading ${setEntry.id}…`;
      const payload = await loadSet("data", manifest, setEntry.file);
      currentSet = setEntry;
      currentPayload = payload;

      wing?.dispose();
      timelines?.dispose();
      histogram?.dispose();
      canvasWrap.innerHTML = "";
      timelinesWrap.innerHTML = "";
      wing2dCanvases.innerHTML = "";
      histogramWrap.innerHTML = "";

      statusEl.textContent = `${setEntry.id} · stiffness factor ${setEntry.stiffnessFactor} · axis ${setEntry.axis}${quickNote}`;

      timelines = createTimelines(timelinesWrap, manifest, payload, computePFire, { onSeek: onChartSeek });
      histogram = createHistogram(histogramWrap, manifest, payload);

      wing2d = createWing2D(wing2dCanvases, manifest, payload, { onSelectSensor: selectSensor });

      wing = createWingScene(canvasWrap, manifest, payload, {
        onFrame: (frameIdx, timeMs) => {
          timelines.setPlayhead(timeMs);
          const strainFrameIdx = Math.floor((frameIdx * payload.strainFrames) / payload.frames);
          wing2d.setFrame(strainFrameIdx);
        },
        onSelectSensor: selectSensor,
        onRotate: (newYaw, newPitch) => {
          yaw = newYaw;
          pitch = newPitch;
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
      wing.setRotation(yaw, pitch);
      wing.setVisible(show3d);
      wing2d.setVisible(!show3d);
      wing.setPaused(paused);
      accuracyN.textContent = String(sensorCount);
      accuracyValue.textContent = `${(payload.accuracyBySensorCount[sensorCount - 1] * 100).toFixed(0)}%`;
      updateAccuracyNotice();
    }

    await loadAndMount(firstSet);

    // --- Left-panel toggle: 3D wings <-> 2D sensor map. Both stay mounted (and the 3D
    // scene's rAF loop -- the app's shared animation clock -- keeps running regardless,
    // see wing3d.js's setVisible), only the expensive per-frame draw work is skipped for
    // whichever one is hidden.
    function applyPanelVisibility() {
      canvasWrap.style.display = show3d ? "" : "none";
      wing2dWrap.style.display = show3d ? "none" : "";
      wing.setVisible(show3d);
      wing2d.setVisible(!show3d);
      if (show3d) wing.resize(); // ResizeObserver delivery for none->block is async; avoid one badly-sized frame
      panelToggle.textContent = show3d ? "⇄ 2D view" : "⇄ 3D view";
    }
    panelToggle.addEventListener("click", () => {
      show3d = !show3d;
      applyPanelVisibility();
    });
    applyPanelVisibility();

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
      loadAndMount(match).then(applyPanelVisibility);
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

    // Play/pause, right next to Animation speed since it controls the same clock.
    // Resuming clears any pinned chart tooltip (see timelines.js's clearPin) --
    // pausing via this button (rather than by clicking a chart) doesn't pin
    // anything, so clearPin is a harmless no-op in that case.
    const playPauseBtn = document.createElement("button");
    playPauseBtn.type = "button";
    // Fixed square size (not padding-driven) so "⏸" and "▶" -- different glyph
    // widths -- never make the button change shape when it toggles.
    playPauseBtn.style.cssText =
      "background:#12151c;color:#e6e6e6;border:1px solid #3d5166;border-radius:4px;font:0.8rem system-ui,sans-serif;cursor:pointer;" +
      "width:28px;height:28px;padding:0;flex:none;display:flex;align-items:center;justify-content:center;box-sizing:border-box;";
    updatePlayButtonLabel();
    playPauseBtn.addEventListener("click", () => {
      paused = !paused;
      wing.setPaused(paused);
      updatePlayButtonLabel();
      if (!paused) timelines.clearPin();
    });
    paramControls.appendChild(playPauseBtn);

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
        loadAndMount(match).then(applyPanelVisibility);
      },
    });
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err.message}`;
    console.error(err);
  }
}

main();
