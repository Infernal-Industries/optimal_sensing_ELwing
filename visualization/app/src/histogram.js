// histogram.js — spanwise optimal-sensor histogram, comparing two
// precomputed sets (e.g. two stiffness factors). Per the design decision
// resolved for Phase 3: the Requirements.pdf sketch's two-group comparison
// ("flapping only" vs "flapping + rotation" bars) turned out, on reading
// the actual paper figure, to be a stylized preview of the REAL finding in
// paper Fig 3 -- that optimal sensor spanwise location shifts between
// wing-base and wing-tip clustering depending on wing stiffness / neural
// threshold, not on flap-vs-rotate as literal separate SSPOC runs (that
// isn't even a valid two-class discrimination problem on its own). So this
// compares two DATASETS (different stiffness factors), each contributing
// one bar series, rather than two conditions within one dataset.
//
// Bar chart per the dataviz skill: bars <=24px thick, 4px rounded data-end
// / square baseline, hairline recessive gridlines, legend always shown for
// 2 series, categorical colors in the same fixed order used elsewhere
// (slot 1 blue / slot 2 orange).

const SERIES_COLORS = ["#3987e5", "#d95926"]; // categorical slots 1, 2 (dark-surface steps)
const INK_SECONDARY = "#c3c2b7";
const INK_MUTED = "#898781";
const GRIDLINE = "#2c2c2a";

const W = 900;
const H = 200;
const PAD = { top: 10, right: 10, bottom: 26, left: 34 };

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * @param {HTMLElement} container
 * @param {object} manifest
 * @param {{id:string, stiffnessFactor:number, spanHistogram:number[]}[]} sets
 *   - one entry per precomputed set to compare (currently 2; Phase 5's full
 *     grid will have more -- this renders however many are passed).
 */
export function createHistogram(container, manifest, sets) {
  const { spanElements, span_mm: spanMm } = manifest.grid;

  const root = document.createElement("div");
  const title = document.createElement("div");
  title.textContent = "Spanwise optimal-sensor distribution (wing base → tip)";
  title.style.cssText = `color:${INK_SECONDARY};font:0.75rem system-ui,sans-serif;margin-bottom:2px;`;
  root.appendChild(title);

  const note = document.createElement("div");
  note.textContent =
    "Comparing across stiffness factors (not flap vs. rotate — see histogram.js for why). Phase 0/1 quick-mode data: not scientifically valid, illustrates the comparison mechanism only.";
  note.style.cssText = `color:${INK_MUTED};font:0.68rem system-ui,sans-serif;margin-bottom:6px;max-width:${W}px;`;
  root.appendChild(note);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: `${H}px` });
  svg.style.display = "block";
  root.appendChild(svg);

  const legend = document.createElement("div");
  legend.style.cssText = `display:flex;gap:14px;font:0.7rem system-ui,sans-serif;color:${INK_SECONDARY};margin-top:4px;`;
  sets.forEach((s, i) => {
    const item = document.createElement("span");
    item.style.cssText = "display:inline-flex;align-items:center;gap:4px;";
    const swatch = document.createElement("span");
    swatch.style.cssText = `display:inline-block;width:10px;height:10px;background:${SERIES_COLORS[i % SERIES_COLORS.length]};border-radius:2px;`;
    item.appendChild(swatch);
    const text = document.createElement("span");
    text.textContent = `${s.id} (stiffness factor ${s.stiffnessFactor})`;
    item.appendChild(text);
    legend.appendChild(item);
  });
  root.appendChild(legend);

  container.appendChild(root);

  const maxCount = Math.max(1, ...sets.flatMap((s) => s.spanHistogram));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const binW = plotW / spanElements;
  const barW = Math.min(24, (binW / sets.length) * 0.8);

  // gridlines + y ticks (0, mid, max -- integers, since counts are small integers)
  for (let i = 0; i <= 2; i++) {
    const val = Math.round((maxCount * i) / 2);
    const y = PAD.top + plotH - (val / maxCount) * plotH;
    svg.appendChild(svgEl("line", { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, stroke: GRIDLINE, "stroke-width": 1 }));
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
  // x-axis labels
  for (const frac of [0, 0.5, 1]) {
    const x = PAD.left + frac * plotW;
    const label = svgEl("text", {
      x,
      y: H - PAD.bottom + 16,
      "text-anchor": frac === 0 ? "start" : frac === 1 ? "end" : "middle",
      fill: INK_MUTED,
      style: "font:0.65rem system-ui,sans-serif",
    });
    label.textContent = frac === 0 ? "wing base (0mm)" : frac === 1 ? `wing tip (${spanMm}mm)` : "";
    svg.appendChild(label);
  }

  sets.forEach((s, seriesIdx) => {
    for (let bin = 0; bin < spanElements; bin++) {
      const count = s.spanHistogram[bin];
      if (count <= 0) continue;
      const barH = (count / maxCount) * plotH;
      const x = PAD.left + bin * binW + seriesIdx * (binW / sets.length) + (binW / sets.length - barW) / 2;
      const y = PAD.top + plotH - barH;
      svg.appendChild(
        svgEl("rect", {
          x,
          y,
          width: barW,
          height: barH,
          rx: 2,
          fill: SERIES_COLORS[seriesIdx % SERIES_COLORS.length],
        })
      );
    }
  });
}
