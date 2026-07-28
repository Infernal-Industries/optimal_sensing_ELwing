// wing2d.js — flat 2D fallback map (Plan §6E): "in case the animated wings
// are too hard to distinguish with all the color shenanigans and 3d
// stuff". Same heatmap (strain/P(fire), toggle-able) and optimal-sensor
// overlay as the 3D scene, always legible since there's no perspective/
// occlusion. Also doubles as a sensor picker: click any cell to show that
// sensor's timeline (not just the top-10 optimal ones).
//
// Orientation: span vertical (base at bottom, tip at top), chord
// horizontal -- matches the 3D scene's world-Y-up convention (wing3d.js's
// buildWingGeometry), NOT plotSensorLocation.m's span-horizontal figure
// layout. Deliberately diverges from the MATLAB plot so the two in-app
// views (3D and this one) read as the same physical orientation when
// toggling between them.
//
// Canvas (not SVG) for the cell grid -- updates every animation frame in
// sync with the 3D view, and redrawing ~1300 DOM elements/frame is far
// more expensive than a canvas fillRect loop.

import { divergingColor, sequentialColor, firingIndicatorColor } from "./colormap.js";
import { computePFireAll } from "./encoding.js";
import { sensorIndexToChordSpan } from "./data.js";

const CONDITION_LABELS = { flap: "flapping only", rotate: "flapping + rotation" };
const CELL_PX = 8; // logical size of one grid cell, scaled by devicePixelRatio for crispness

function maxAbsStrain(payload) {
  let m = 0;
  for (const cond of ["flap", "rotate"]) {
    for (const sensor of payload.conditions[cond].strain) {
      for (const v of sensor) if (Math.abs(v) > m) m = Math.abs(v);
    }
  }
  return m || 1;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * @param {HTMLElement} container
 * @param {object} manifest
 * @param {object} payload
 * @param {{onSelectSensor?: (sensorIdx1:number) => void}} [opts]
 * @returns {{setColorMode, setThreshold, setSensorCount, setFrame, setVisible}}
 */
export function createWing2D(container, manifest, payload, opts = {}) {
  const { chordElements, spanElements } = manifest.grid;
  const strainBound = maxAbsStrain(payload);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvases = {};
  const ctxs = {};

  let colorMode = "strain";
  let sensorCount = 10;
  let visible = true;
  let lastFrameIdx = 0;
  let pfireByCondition = {};
  function recomputePFire(nldGrad, nldShift, staFreq) {
    pfireByCondition = {};
    for (const cond of ["flap", "rotate"]) {
      pfireByCondition[cond] = computePFireAll(payload.conditions[cond].strain, manifest.encoding, nldGrad, nldShift, staFreq);
    }
  }
  recomputePFire(manifest.encoding.nldGrad, manifest.encoding.nldShift, manifest.encoding.staFreq);

  for (const cond of ["flap", "rotate"]) {
    const wrap = document.createElement("div");
    const title = document.createElement("div");
    title.textContent = CONDITION_LABELS[cond];
    title.style.cssText = "color:#c3c2b7;font:0.72rem system-ui,sans-serif;margin-bottom:2px;flex:none;";
    wrap.appendChild(title);

    const canvas = document.createElement("canvas");
    // Width <- chord, height <- span, matching the 3D scene's orientation.
    canvas.width = chordElements * CELL_PX * dpr;
    canvas.height = spanElements * CELL_PX * dpr;
    // No inline width/height style -- index.html's CSS scales via
    // `height:100%; width:auto`, and the canvas element's intrinsic
    // width/height attributes above preserve the correct aspect ratio.
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    canvases[cond] = canvas;
    ctxs[cond] = canvas.getContext("2d");

    canvas.addEventListener("click", (ev) => {
      const rect = canvas.getBoundingClientRect();
      const chordIdx = clamp(Math.floor(((ev.clientX - rect.left) / rect.width) * chordElements), 0, chordElements - 1);
      // si=0 is the wing base, drawn at the BOTTOM (matching wing3d.js's
      // Y-up world convention) -- so increasing screen-Y (downward) maps to
      // decreasing spanIdx.
      const spanIdx = clamp(
        spanElements - 1 - Math.floor(((ev.clientY - rect.top) / rect.height) * spanElements),
        0,
        spanElements - 1
      );
      const sensorIdx1 = spanIdx * chordElements + chordIdx + 1; // inverse of sensorIndexToChordSpan
      if (opts.onSelectSensor) opts.onSelectSensor(sensorIdx1);
    });
  }

  function render(strainFrameIdx) {
    const optimalSet = payload.optimalSensors.top10.slice(0, sensorCount);
    for (const cond of ["flap", "rotate"]) {
      const ctx = ctxs[cond];
      const strain = payload.conditions[cond].strain;
      const pfire = pfireByCondition[cond];
      const px = CELL_PX * dpr;

      for (let ci = 0; ci < chordElements; ci++) {
        for (let si = 0; si < spanElements; si++) {
          const sensorIdx0 = si * chordElements + ci;
          const [r, g, b] =
            colorMode === "pfire"
              ? sequentialColor(pfire[sensorIdx0][strainFrameIdx])
              : divergingColor(strain[sensorIdx0][strainFrameIdx], strainBound);
          ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
          ctx.fillRect(ci * px, (spanElements - 1 - si) * px, px, px);
        }
      }

      // optimal sensor overlay -- always P(fire)-colored (Req #1), same as the 3D markers
      for (const sensorIdx1 of optimalSet) {
        const { chordIdx, spanIdx } = sensorIndexToChordSpan(sensorIdx1, chordElements);
        const [r, g, b] = firingIndicatorColor(pfire[sensorIdx1 - 1][strainFrameIdx]);
        ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
        ctx.beginPath();
        ctx.arc(chordIdx * px + px / 2, (spanElements - 1 - spanIdx) * px + px / 2, px * 0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#1a1a19";
        ctx.lineWidth = Math.max(1, px * 0.08);
        ctx.stroke();
      }
    }
  }

  render(0);

  return {
    setColorMode(mode) {
      colorMode = mode;
      if (visible) render(lastFrameIdx);
    },
    setThreshold(nldGrad, nldShift, staFreq) {
      recomputePFire(nldGrad, nldShift, staFreq);
      if (visible) render(lastFrameIdx);
    },
    setSensorCount(n) {
      sensorCount = n;
      if (visible) render(lastFrameIdx);
    },
    /** @param {number} frameIdx - index into payload.strainFrames-length arrays */
    setFrame(frameIdx) {
      lastFrameIdx = frameIdx;
      if (visible) render(frameIdx);
    },
    /** Skips the ~2600-fillRect-per-frame redraw while this panel isn't shown. */
    setVisible(v) {
      visible = v;
      if (v) render(lastFrameIdx);
    },
  };
}
