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
// Bar chart per the dataviz skill: 4px rounded data-end / square baseline,
// hairline recessive gridlines, legend always shown for 2 series,
// categorical colors reused from timelines.js's fixed flap/rotate
// assignment (identity must stay consistent across the app). Bar width is
// NOT capped -- it's derived from pxPerBin (see layoutSegments), which can
// legitimately be large when a burst only has a few active bins.

import { computePFire, samplePSTH } from "./encoding.js";

const COLORS = {
  flap: { bar: "#3987e5", label: "flapping only" },
  rotate: { bar: "#d95926", label: "flapping + rotation" },
};
const INK_SECONDARY = "#c3c2b7";
const INK_MUTED = "#898781";
const GRIDLINE = "#2c2c2a";

const H = 160;
const PAD = { top: 10, right: 10, bottom: 26, left: 34 };
const N_REPS = 300; // simulated wingbeats per PSTH draw -- paper uses "hundreds"

// Empty (both-conditions-zero) bins get compressed into a fixed-width "⋯"
// axis-break marker instead of wasting chart width -- real spike activity
// clusters into a couple of narrow bursts, so most of the native-resolution
// bin axis would otherwise just be dead space. Only runs at least GAP_MIN_MS
// wide collapse (with an absolute floor in bins) -- a single stray zero bin
// from sampling noise inside a burst shouldn't fragment it into two peaks
// with a tiny meaningless ellipsis between them.
const GAP_MIN_MS = 1.5;
const GAP_MIN_BINS_FLOOR = 3;
const GAP_PX = 32; // fixed screen width for each collapsed-gap marker

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Finds runs of consecutive bins where both conditions are zero, and keeps
 * only the ones wide enough to be worth collapsing (see GAP_MIN_MS above).
 * @returns {{start:number, end:number}[]} end exclusive
 */
function findCollapsibleGaps(counts, nBins, dt) {
  const gapMinBins = Math.max(GAP_MIN_BINS_FLOOR, Math.round(GAP_MIN_MS / dt));
  const gaps = [];
  let i = 0;
  while (i < nBins) {
    if (counts.flap[i] > 0 || counts.rotate[i] > 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < nBins && counts.flap[j] <= 0 && counts.rotate[j] <= 0) j++;
    if (j - i >= gapMinBins) gaps.push({ start: i, end: j });
    i = j;
  }
  return gaps;
}

/**
 * Builds the ordered list of alternating data/gap segments covering
 * [0, nBins), from the collapsible gaps found above.
 *   'data' segments: {type, start, end} -- bins to actually draw bars for.
 *   'gap' segments: {type, start, end, isLeading, isTrailing} -- isLeading
 *   means "no earlier data, so label the left side as 0 rather than a real
 *   bin time"; isTrailing means "no later data, so omit the right label
 *   entirely" (per the user's labeling rule).
 */
function buildSegments(counts, nBins, dt, ellipsisEnabled) {
  // TEMP: ellipsisEnabled is a debug toggle (see createHistogram's
  // setEllipsisEnabled) to compare against the uncollapsed, native-resolution
  // axis -- when off, skip gap detection entirely so every bin gets its own
  // 'data' segment share of the width.
  const gaps = ellipsisEnabled ? findCollapsibleGaps(counts, nBins, dt) : [];
  const segments = [];
  let cursor = 0;
  for (const g of gaps) {
    if (g.start > cursor) segments.push({ type: "data", start: cursor, end: g.start });
    segments.push({
      type: "gap",
      start: g.start,
      end: g.end,
      isLeading: g.start === 0,
      isTrailing: g.end === nBins,
    });
    cursor = g.end;
  }
  if (cursor < nBins) segments.push({ type: "data", start: cursor, end: nBins });
  return segments;
}

/**
 * Weighted mean spike time (ms) for one condition, over one contiguous bin
 * range [start,end) -- i.e. one unbroken ("no ellipsis") data segment.
 * Weighted by spike count per bin, since a bin's "value" for this purpose is
 * its time, repeated `count` times.
 * @returns {{mean: number|null}} null when the segment has zero spikes for
 *   this condition (nothing to average).
 */
function weightedStats(countsForCond, start, end, dt) {
  let total = 0;
  let sumTime = 0;
  for (let b = start; b < end; b++) {
    const c = countsForCond[b];
    total += c;
    sumTime += c * (b * dt);
  }
  if (total <= 0) return { mean: null };
  return { mean: sumTime / total };
}

/**
 * Assigns each segment its [x0,x1) pixel band: gaps get a fixed GAP_PX;
 * the remaining width is divided among data segments at one constant
 * px-per-bin (so relative burst widths stay comparable to each other, and
 * -- since dead space no longer eats most of the width -- bursts occupy far
 * more of the chart than a uniform full-axis scale would give them).
 * Mutates `segments` in place with x0/x1; safe to call every render() since
 * it only depends on plotW (which may change on resize) and is idempotent.
 * @returns {number} pxPerBin
 */
function layoutSegments(segments, plotW) {
  const dataSegs = segments.filter((s) => s.type === "data");
  const nGaps = segments.length - dataSegs.length;
  const activeBinsTotal = dataSegs.reduce((sum, s) => sum + (s.end - s.start), 0);
  const availableForData = Math.max(1, plotW - nGaps * GAP_PX);
  const pxPerBin = activeBinsTotal > 0 ? availableForData / activeBinsTotal : 0;

  let x = PAD.left;
  for (const seg of segments) {
    seg.x0 = x;
    seg.x1 = seg.type === "data" ? x + (seg.end - seg.start) * pxPerBin : x + GAP_PX;
    x = seg.x1;
  }
  return pxPerBin;
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
  note.style.cssText = `color:${INK_MUTED};font:0.68rem system-ui,sans-serif;margin-bottom:2px;max-width:100%;`;
  root.appendChild(note);

  // Per-unbroken-region (i.e. per 'data' segment -- excludes the collapsed
  // "⋯" gaps) mean spike time, per condition.
  const statsEl = document.createElement("div");
  statsEl.id = "histogram-stats";
  statsEl.style.cssText = `color:${INK_SECONDARY};font:0.68rem system-ui,sans-serif;margin-bottom:6px;max-width:100%;`;
  root.appendChild(statsEl);

  // W tracks the container's actual width (updated by the ResizeObserver
  // below) so the chart fills whatever space the bottom row has, rather than
  // being fixed-px and either letterboxed or overflowing.
  let W = 900;

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
  {
    const item = document.createElement("span");
    item.style.cssText = `display:inline-flex;align-items:center;gap:4px;color:${INK_MUTED};`;
    item.textContent = "— mean";
    legend.appendChild(item);
  }
  root.appendChild(legend);

  container.appendChild(root);

  let sensorIdx = payload.optimalSensors.top1 - 1; // 0-based
  let nldGrad = manifest.encoding.nldGrad;
  let nldShift = manifest.encoding.nldShift;
  let staFreq = manifest.encoding.staFreq;
  // TEMP: debug toggle for the gap-collapsing "⋯" feature -- see
  // setEllipsisEnabled below and main.js's temporary checkbox.
  let ellipsisEnabled = true;

  // recompute() does the stochastic sampling (samplePSTH draws fresh random
  // spike trains every call) and caches the result in `counts`, plus the
  // resulting gap/segment layout (which only depends on `counts`, not on
  // plotW). render() only ever draws from that cache -- kept separate so a
  // resize (which should just redraw at a new width) never re-randomizes
  // the bars, which would otherwise visibly shimmer while dragging a window
  // edge, and never re-detects gaps either.
  let counts = null;
  let maxCount = 1;
  let segments = null;

  function recompute() {
    const refPerSamples = Math.round((manifest.encoding.refPer * manifest.encoding.sampFreq) / 1000);
    counts = {};
    maxCount = 1;
    for (const cond of ["flap", "rotate"]) {
      const strainRow = payload.conditions[cond].strain[sensorIdx];
      const pfire = computePFire(strainRow, manifest.encoding, nldGrad, nldShift, staFreq);
      counts[cond] = samplePSTH(pfire, refPerSamples, N_REPS);
      maxCount = Math.max(maxCount, ...counts[cond]);
    }
    const nBins = counts.flap.length;
    const dt = payload.period_ms / nBins;
    segments = buildSegments(counts, nBins, dt, ellipsisEnabled);
    note.textContent =
      `Sensor #${sensorIdx + 1}, ${N_REPS} simulated wingbeats per condition (client-side, refractory period ` +
      `${manifest.encoding.refPer}ms), spike trains sampled from the real P(fire) curve above.`;

    // Computed once here (not in render(), which also runs on every resize) and
    // stashed directly on each data segment -- render() draws mean/median marker
    // lines from these, and the stats text below reads the same numbers, so
    // there's only one weightedStats() call per condition per segment.
    const dataSegs = segments.filter((s) => s.type === "data");
    for (const seg of dataSegs) {
      seg.stats = {
        flap: weightedStats(counts.flap, seg.start, seg.end, dt),
        rotate: weightedStats(counts.rotate, seg.start, seg.end, dt),
      };
    }

    // 2 decimal places, not 1 -- unbroken regions are often only ~1ms wide
    // (native sample resolution), so two genuinely different means (e.g.
    // 8.02ms vs 8.07ms) previously both rounded to the same "8.0ms" in this
    // text even though the graphed mean lines (which use the full-precision
    // value for their pixel position) visibly landed apart. The underlying
    // stat was always correct -- only this display rounding hid the real
    // difference.
    const fmt = (v) => (v === null ? "no spikes" : `${v.toFixed(2)}ms`);
    statsEl.innerHTML = dataSegs
      .map((seg, i) => {
        const range = `${Math.round(seg.start * dt)}–${Math.round((seg.end - 1) * dt)}ms`;
        const label = dataSegs.length > 1 ? `Region ${i + 1} (${range})` : `${range}`;
        return (
          `${label}: ` +
          `<span style="color:${COLORS.flap.bar}">flap</span> mean ${fmt(seg.stats.flap.mean)}` +
          ` · ` +
          `<span style="color:${COLORS.rotate.bar}">rotate</span> mean ${fmt(seg.stats.rotate.mean)}`
        );
      })
      .join("<br>");

    render();
  }

  function render() {
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.textContent = "";
    if (!counts) return;

    const nBins = counts.flap.length;
    const dt = payload.period_ms / nBins;
    const binMs = (bin) => bin * dt;
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const pxPerBin = layoutSegments(segments, plotW);
    // No upper cap: when a burst has few active bins, pxPerBin (the width
    // reallocated to it after gap-collapsing) can get large -- capping barW
    // left a thin bar stranded in a huge slot, i.e. exactly the large empty
    // gaps between bars this whole segment-layout scheme exists to remove.
    const barW = Math.max(1, pxPerBin * 0.85);

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

    function xAxisLabel(x, anchor, text) {
      const label = svgEl("text", {
        x,
        y: H - PAD.bottom + 16,
        "text-anchor": anchor,
        fill: INK_MUTED,
        style: "font:0.65rem system-ui,sans-serif",
      });
      label.textContent = text;
      svg.appendChild(label);
    }

    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];
    // Edge labels only appear where a gap isn't already providing that
    // boundary's label (a leading/trailing gap's own label below covers it).
    if (firstSeg.type === "data") xAxisLabel(PAD.left, "start", "0ms");
    if (lastSeg.type === "data") xAxisLabel(W - PAD.right, "end", `${Math.round(payload.period_ms)}ms`);

    for (const seg of segments) {
      if (seg.type !== "gap") continue;
      const cx = (seg.x0 + seg.x1) / 2;
      const ellipsis = svgEl("text", {
        x: cx,
        y: H - PAD.bottom + 16,
        "text-anchor": "middle",
        fill: INK_MUTED,
        style: "font:0.7rem system-ui,sans-serif",
      });
      ellipsis.textContent = "⋯";
      svg.appendChild(ellipsis);

      // Leading gap: no real data before it, so label "0" per the rule
      // (rather than omitting it, since there's no natural bin to report).
      xAxisLabel(seg.x0 - 4, "end", seg.isLeading ? "0ms" : `${Math.round(binMs(seg.start - 1))}ms`);
      // Trailing gap: nothing follows, so no right label at all.
      if (!seg.isTrailing) {
        xAxisLabel(seg.x1 + 4, "start", `${Math.round(binMs(seg.end))}ms`);
      }
    }

    // Fully overlapping bars (same x for both series), each semi-transparent
    // so both true heights stay visible through the other. Only bins inside
    // 'data' segments are drawn -- collapsed-gap bins have nothing to show.
    for (const seg of segments) {
      if (seg.type !== "data") continue;
      for (let bin = seg.start; bin < seg.end; bin++) {
        const binX0 = seg.x0 + (bin - seg.start) * pxPerBin;
        for (const cond of ["flap", "rotate"]) {
          const count = counts[cond][bin];
          if (count <= 0) continue;
          const barH = (count / maxCount) * plotH;
          const x = binX0 + (pxPerBin - barW) / 2;
          const y = PAD.top + plotH - barH;
          svg.appendChild(
            svgEl("rect", {
              x,
              y,
              width: barW,
              height: barH,
              rx: 1.5,
              fill: COLORS[cond].bar,
              "fill-opacity": 0.6,
            })
          );
        }
      }
    }

    // Mean marker line per condition, per unbroken region -- drawn on top of
    // the bars, thin and semi-transparent so the bars underneath stay
    // legible. Stats were computed once in recompute() (see seg.stats), not
    // re-derived here.
    for (const seg of segments) {
      if (seg.type !== "data" || !seg.stats) continue;
      for (const cond of ["flap", "rotate"]) {
        const { mean } = seg.stats[cond];
        if (mean === null) continue;
        const x = seg.x0 + (mean / dt - seg.start) * pxPerBin;
        svg.appendChild(
          svgEl("line", {
            x1: x,
            x2: x,
            y1: PAD.top,
            y2: PAD.top + plotH,
            stroke: COLORS[cond].bar,
            "stroke-width": 1.5,
            opacity: 0.85,
          })
        );
      }
    }
  }

  const resizeObserver = new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width;
    if (w > 0 && Math.abs(w - W) > 1) {
      W = w;
      render(); // draw-only -- does not re-sample counts
    }
  });
  resizeObserver.observe(root);

  recompute();

  return {
    setSensor(newSensorIdx) {
      sensorIdx = newSensorIdx;
      recompute();
    },
    setThreshold(newNldGrad, newNldShift, newStaFreq) {
      nldGrad = newNldGrad;
      nldShift = newNldShift;
      staFreq = newStaFreq;
      recompute();
    },
    // TEMP: debug toggle -- remove along with the checkbox in main.js once
    // the ellipsis feature no longer needs an easy side-by-side comparison.
    setEllipsisEnabled(v) {
      ellipsisEnabled = v;
      recompute();
    },
    // main.js recreates this on every dataset reload (every stiffness/axis
    // change), so the ResizeObserver must be explicitly torn down or it
    // keeps observing a detached `root` indefinitely.
    dispose() {
      resizeObserver.disconnect();
    },
  };
}
