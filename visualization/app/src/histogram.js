// histogram.js — peristimulus time histogram (PSTH) of spike times for the
// currently-selected sensor, comparing flap-only vs. flap+rotation. Matches
// paper Fig 2E: "Histogram of spike times (PSTHs) for each condition,
// summarizing spike timing over hundreds of wingbeats."
//
// This replaces an earlier design (spanwise sensor-location histogram,
// comparing across stiffness datasets) built for Phase 3. On reflection,
// the Requirements.pdf sketch's two groups -- "flapping only" / "flapping
// + rotation" -- map far more naturally onto a PSTH's per-condition
// comparison (which the paper genuinely computes) than onto spanwise
// sensor clustering (which the paper compares across stiffness/threshold,
// not flap-vs-rotate -- see the git history for that earlier reasoning).
//
// Spike times are generated client-side via encoding.js's samplePSTH --
// repeated stochastic draws from the same P(fire) curve, respecting the
// refractory period, exactly matching convertProbFiringToSpikes.m's
// method (verified numerically before use, see encoding.js).
//
// Bar chart per the dataviz skill: bars <=24px, 4px rounded data-end /
// square baseline, hairline recessive gridlines, legend always shown for
// 2 series, categorical colors reused from timelines.js's fixed
// flap/rotate assignment (identity must stay consistent across the app).

import { computePFire, samplePSTH } from "./encoding.js";

const COLORS = {
  flap: { bar: "#3987e5", label: "flapping only" },
  rotate: { bar: "#d95926", label: "flapping + rotation" },
};
const INK_SECONDARY = "#c3c2b7";
const INK_MUTED = "#898781";
const GRIDLINE = "#2c2c2a";

const W = 900;
const H = 200;
const PAD = { top: 10, right: 10, bottom: 26, left: 34 };
const N_REPS = 300; // simulated wingbeats per PSTH draw -- paper uses "hundreds"

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * @param {HTMLElement} container
 * @param {object} manifest
 * @param {object} payload
 */
export function createHistogram(container, manifest, payload) {
  const root = document.createElement("div");
  const title = document.createElement("div");
  title.textContent = "Spike-time histogram (PSTH) — selected sensor";
  title.style.cssText = `color:${INK_SECONDARY};font:0.75rem system-ui,sans-serif;margin-bottom:2px;`;
  root.appendChild(title);

  const note = document.createElement("div");
  note.id = "histogram-note";
  note.style.cssText = `color:${INK_MUTED};font:0.68rem system-ui,sans-serif;margin-bottom:6px;max-width:${W}px;`;
  root.appendChild(note);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: `${H}px` });
  svg.style.display = "block";
  root.appendChild(svg);

  const legend = document.createElement("div");
  legend.style.cssText = `display:flex;gap:14px;font:0.7rem system-ui,sans-serif;color:${INK_SECONDARY};margin-top:4px;`;
  for (const key of ["flap", "rotate"]) {
    const item = document.createElement("span");
    item.style.cssText = "display:inline-flex;align-items:center;gap:4px;";
    const swatch = document.createElement("span");
    swatch.style.cssText = `display:inline-block;width:10px;height:10px;background:${COLORS[key].bar};border-radius:2px;`;
    item.appendChild(swatch);
    const text = document.createElement("span");
    text.textContent = COLORS[key].label;
    item.appendChild(text);
    legend.appendChild(item);
  }
  root.appendChild(legend);

  container.appendChild(root);

  let sensorIdx = payload.optimalSensors.top1 - 1; // 0-based
  let nldGrad = manifest.encoding.nldGrad;
  let nldShift = manifest.encoding.nldShift;

  function render() {
    svg.textContent = "";

    const refPerSamples = Math.round(
      (manifest.encoding.refPer * manifest.encoding.sampFreq) / 1000
    );

    const counts = {};
    let maxCount = 1;
    for (const cond of ["flap", "rotate"]) {
      const strainRow = payload.conditions[cond].strain[sensorIdx];
      const pfire = computePFire(strainRow, manifest.encoding, nldGrad, nldShift);
      counts[cond] = samplePSTH(pfire, refPerSamples, N_REPS);
      maxCount = Math.max(maxCount, ...counts[cond]);
    }

    note.textContent =
      `Sensor #${sensorIdx + 1}, ${N_REPS} simulated wingbeats per condition (client-side, refractory period ` +
      `${manifest.encoding.refPer}ms). Phase 0/1 quick-mode data: not scientifically valid, illustrates the mechanism only.`;

    const nBins = counts.flap.length;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const binW = plotW / nBins;
    const barW = Math.max(1, Math.min(24, binW * 0.85));

    for (let i = 0; i <= 2; i++) {
      const val = Math.round((maxCount * i) / 2);
      const y = PAD.top + plotH - (val / maxCount) * plotH;
      svg.appendChild(
        svgEl("line", { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, stroke: GRIDLINE, "stroke-width": 1 })
      );
      const label = svgEl("text", {
        x: PAD.left - 6,
        y: y + 3,
        "text-anchor": "end",
        fill: INK_MUTED,
        style: "font:0.65rem system-ui,sans-serif",
      });
      label.textContent = String(val);
      svg.appendChild(label);
    }
    for (const tx of [0, payload.period_ms / 2, payload.period_ms]) {
      const x = PAD.left + (tx / payload.period_ms) * plotW;
      const label = svgEl("text", {
        x,
        y: H - PAD.bottom + 16,
        "text-anchor": tx === 0 ? "start" : tx === payload.period_ms ? "end" : "middle",
        fill: INK_MUTED,
        style: "font:0.65rem system-ui,sans-serif",
      });
      label.textContent = `${Math.round(tx)}ms`;
      svg.appendChild(label);
    }

    // Overlapping (not side-by-side) bars, matching the paper's PSTH style
    // (Fig 2E) -- both series occupy the same x position per bin at ~65%
    // opacity, so overlap reads as a blended color rather than two
    // adjacent bars that could misread as alternating/evenly spaced. Fixed
    // draw order (flap, then rotate) for a consistent look bin to bin.
    ["flap", "rotate"].forEach((cond) => {
      for (let bin = 0; bin < nBins; bin++) {
        const count = counts[cond][bin];
        if (count <= 0) continue;
        const barH = (count / maxCount) * plotH;
        const x = PAD.left + bin * binW + (binW - barW) / 2;
        const y = PAD.top + plotH - barH;
        svg.appendChild(
          svgEl("rect", {
            x,
            y,
            width: barW,
            height: barH,
            rx: 1.5,
            fill: COLORS[cond].bar,
            "fill-opacity": 0.65,
          })
        );
      }
    });
  }

  render();

  return {
    setSensor(newSensorIdx) {
      sensorIdx = newSensorIdx;
      render();
    },
    setThreshold(newNldGrad, newNldShift) {
      nldGrad = newNldGrad;
      nldShift = newNldShift;
      render();
    },
  };
}
