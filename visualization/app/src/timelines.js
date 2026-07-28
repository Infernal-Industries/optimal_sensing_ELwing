// timelines.js — strain & P(fire) line charts for one selected sensor, with
// a sweeping playhead synced to the 3D animation and a hover crosshair +
// tooltip. Two separate charts (not one dual-axis chart, per the dataviz
// skill's "one axis" rule -- strain and P(fire) are different units).
//
// Series identity (flap vs. rotate) is a categorical job: fixed hue order,
// palette.md slots 1 (blue) and 2 (orange), never cycled/reassigned.

const COLORS = {
  flap: { line: "#3987e5", label: "flapping only" }, // categorical slot 1 (dark-surface step)
  rotate: { line: "#d95926", label: "flapping + rotation" }, // categorical slot 2
};
const INK_PRIMARY = "#ffffff";
const INK_SECONDARY = "#c3c2b7";
const INK_MUTED = "#898781";
const GRIDLINE = "#2c2c2a";
const SURFACE = "#1a1a19";

const PAD = { top: 10, right: 10, bottom: 22, left: 40 };

function svgEl(tag, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function niceTicks(min, max, count) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const ticks = [];
  for (let i = 0; i <= count; i++) ticks.push(min + ((max - min) * i) / count);
  return ticks;
}

/**
 * One line chart: two series (flap/rotate) over a shared time axis, plus a
 * playhead and hover crosshair+tooltip. Fills its container (via a
 * ResizeObserver keeping the SVG viewBox equal to the container's actual
 * CSS pixel size) instead of being fixed-px, so xScale/yScale always map
 * 1:1 to real screen coordinates -- this also fixes the tooltip position
 * for free, which previously mixed viewBox units with CSS px.
 * @param {HTMLElement} container
 * @param {{title:string, yFormat:(v:number)=>string}} opts
 */
function createChart(container, opts) {
  const root = document.createElement("div");
  root.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;";
  const titleEl = document.createElement("div");
  titleEl.textContent = opts.title;
  titleEl.style.cssText = `color:${INK_SECONDARY};font:0.75rem system-ui,sans-serif;margin-bottom:2px;flex:none;`;
  root.appendChild(titleEl);

  let W = 560;
  let H = 160;

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}` });
  svg.style.cssText = "display:block;width:100%;flex:1;min-height:0;";
  root.appendChild(svg);

  const legend = document.createElement("div");
  legend.style.cssText = `display:flex;gap:12px;font:0.7rem system-ui,sans-serif;color:${INK_SECONDARY};margin-top:2px;flex:none;`;
  for (const key of ["flap", "rotate"]) {
    const item = document.createElement("span");
    item.style.cssText = "display:inline-flex;align-items:center;gap:4px;";
    const swatch = document.createElement("span");
    swatch.style.cssText = `display:inline-block;width:10px;height:2px;background:${COLORS[key].line};`;
    item.appendChild(swatch);
    const text = document.createElement("span");
    text.textContent = COLORS[key].label;
    item.appendChild(text);
    legend.appendChild(item);
  }
  root.appendChild(legend);

  const tooltip = document.createElement("div");
  tooltip.style.cssText = `position:absolute;pointer-events:none;background:${SURFACE};border:1px solid ${GRIDLINE};color:${INK_PRIMARY};font:0.7rem system-ui,sans-serif;padding:4px 6px;border-radius:3px;display:none;white-space:nowrap;z-index:10;`;
  root.appendChild(tooltip);

  container.appendChild(root);

  const gridGroup = svgEl("g", {});
  const dataGroup = svgEl("g", {});
  const playhead = svgEl("line", {
    y1: PAD.top,
    y2: H - PAD.bottom,
    stroke: INK_PRIMARY,
    "stroke-width": 1,
    opacity: 0.9,
  });
  const crosshair = svgEl("line", {
    y1: PAD.top,
    y2: H - PAD.bottom,
    stroke: INK_MUTED,
    "stroke-width": 1,
    "stroke-dasharray": "2,2",
    opacity: 0,
  });
  const hitRect = svgEl("rect", {
    x: PAD.left,
    y: PAD.top,
    width: W - PAD.left - PAD.right,
    height: H - PAD.top - PAD.bottom,
    fill: "transparent",
  });

  svg.appendChild(gridGroup);
  svg.appendChild(dataGroup);
  svg.appendChild(playhead);
  svg.appendChild(crosshair);
  svg.appendChild(hitRect);

  let xDomain = [0, 1];
  let yDomain = [0, 1];
  let seriesData = { flap: [], rotate: [] }; // arrays of {x, y}
  let lastPlayheadX = 0;

  function xScale(x) {
    return PAD.left + ((x - xDomain[0]) / (xDomain[1] - xDomain[0])) * (W - PAD.left - PAD.right);
  }
  function yScale(y) {
    return H - PAD.bottom - ((y - yDomain[0]) / (yDomain[1] - yDomain[0])) * (H - PAD.top - PAD.bottom);
  }

  function render() {
    gridGroup.textContent = "";
    dataGroup.textContent = "";

    // gridlines + y ticks
    for (const ty of niceTicks(yDomain[0], yDomain[1], 3)) {
      const y = yScale(ty);
      gridGroup.appendChild(
        svgEl("line", { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, stroke: GRIDLINE, "stroke-width": 1 })
      );
      const label = svgEl("text", {
        x: PAD.left - 6,
        y: y + 3,
        "text-anchor": "end",
        fill: INK_MUTED,
        style: "font:0.65rem system-ui,sans-serif",
      });
      label.textContent = opts.yFormat(ty);
      gridGroup.appendChild(label);
    }
    // x-axis ticks (ms)
    for (const tx of niceTicks(xDomain[0], xDomain[1], 4)) {
      const x = xScale(tx);
      const label = svgEl("text", {
        x,
        y: H - PAD.bottom + 14,
        "text-anchor": "middle",
        fill: INK_MUTED,
        style: "font:0.65rem system-ui,sans-serif",
      });
      label.textContent = `${Math.round(tx)}ms`;
      gridGroup.appendChild(label);
    }

    for (const key of ["flap", "rotate"]) {
      const pts = seriesData[key];
      if (!pts.length) continue;
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.x).toFixed(1)},${yScale(p.y).toFixed(1)}`).join(" ");
      dataGroup.appendChild(
        svgEl("path", { d, fill: "none", stroke: COLORS[key].line, "stroke-width": 2, "stroke-linejoin": "round" })
      );
    }
  }

  // Keeps viewBox equal to the SVG's actual rendered CSS pixel size, so
  // xScale/yScale (and therefore the tooltip's CSS-px position below) never
  // need a separate viewBox<->CSS-px conversion factor.
  function applyResize(w, h) {
    if (!w || !h || (Math.abs(w - W) < 1 && Math.abs(h - H) < 1)) return;
    W = w;
    H = h;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    playhead.setAttribute("y2", H - PAD.bottom);
    crosshair.setAttribute("y2", H - PAD.bottom);
    hitRect.setAttribute("width", W - PAD.left - PAD.right);
    hitRect.setAttribute("height", H - PAD.top - PAD.bottom);
    render();
    setPlayheadX(lastPlayheadX); // re-apply in the new W-based scale, not stale units
  }
  const resizeObserver = new ResizeObserver((entries) => {
    const { width, height } = entries[0].contentRect;
    applyResize(width, height);
  });
  resizeObserver.observe(svg);

  hitRect.addEventListener("pointermove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const svgX = ((ev.clientX - rect.left) / rect.width) * W;
    const t = xDomain[0] + ((svgX - PAD.left) / (W - PAD.left - PAD.right)) * (xDomain[1] - xDomain[0]);
    const flapPts = seriesData.flap;
    if (!flapPts.length) return;
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < flapPts.length; i++) {
      const d = Math.abs(flapPts[i].x - t);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    const nearestX = flapPts[idx].x;
    crosshair.setAttribute("x1", xScale(nearestX));
    crosshair.setAttribute("x2", xScale(nearestX));
    crosshair.setAttribute("opacity", 1);

    const rows = ["flap", "rotate"]
      .map((key) => {
        const p = seriesData[key][idx];
        return p ? `<span style="color:${COLORS[key].line}">━</span> ${opts.yFormat(p.y)}` : "";
      })
      .join("<br>");
    tooltip.innerHTML = `${Math.round(nearestX)}ms<br>${rows}`;
    tooltip.style.display = "block";
    // xScale() returns viewBox units, which now equal real CSS px 1:1 (see
    // applyResize) since W/H track the SVG's actual rendered size.
    tooltip.style.left = `${xScale(nearestX) + 8}px`;
    tooltip.style.top = "4px";
  });
  hitRect.addEventListener("pointerleave", () => {
    crosshair.setAttribute("opacity", 0);
    tooltip.style.display = "none";
  });

  function setPlayheadX(x) {
    lastPlayheadX = x;
    const px = xScale(x);
    playhead.setAttribute("x1", px);
    playhead.setAttribute("x2", px);
  }

  return {
    setDomains(newXDomain, newYDomain) {
      xDomain = newXDomain;
      yDomain = newYDomain;
    },
    setSeries(flapPts, rotatePts) {
      seriesData = { flap: flapPts, rotate: rotatePts };
      render();
    },
    setPlayheadX,
    dispose() {
      resizeObserver.disconnect();
    },
  };
}

/**
 * @param {HTMLElement} container
 * @param {object} manifest
 * @param {object} payload
 * @param {import("./encoding.js")} encodingModule - pass computePFire in
 */
export function createTimelines(container, manifest, payload, computePFire) {
  // Each chart's root is `position:absolute;inset:0` (see createChart) so it can
  // ResizeObserver-track its own slot's exact pixel size -- it needs its OWN
  // positioned wrapper, not to share `container` directly with the other chart
  // (index.html's `#timelines-wrap > div` CSS already styles these: flex:1,
  // min-height:0, position:relative).
  const strainWrap = document.createElement("div");
  container.appendChild(strainWrap);
  const pfireWrap = document.createElement("div");
  container.appendChild(pfireWrap);

  const strainChart = createChart(strainWrap, {
    title: "Strain",
    yFormat: (v) => v.toExponential(1),
  });
  const pfireChart = createChart(pfireWrap, {
    title: "P(fire)",
    yFormat: (v) => v.toFixed(2),
  });

  let sensorIdx = payload.optimalSensors.top1 - 1; // 0-based
  let nldGrad = manifest.encoding.nldGrad;
  let nldShift = manifest.encoding.nldShift;
  let staFreq = manifest.encoding.staFreq;

  function msPerStrainSample() {
    return payload.period_ms / payload.strainFrames;
  }

  function recompute() {
    const strainXDomain = [0, payload.period_ms];
    const pfireXDomain = [0, payload.period_ms];

    let yMin = Infinity;
    let yMax = -Infinity;
    const strainSeries = {};
    const pfireSeries = {};

    for (const cond of ["flap", "rotate"]) {
      const fullRow = payload.conditions[cond].strain[sensorIdx];
      const displayRow = fullRow.slice(payload.strainLeadInFrames); // drop lead-in for display
      const dt = msPerStrainSample();
      // fullRow/displayRow are Float32Array views (Phase 5's binary strain
      // sidecar, see data.js) -- Array.prototype.map on a typed array
      // always coerces its return value back to that array's numeric type,
      // so mapping to {x,y} objects here would silently produce NaN. Use
      // Array.from's mapping form instead, which always returns a plain array.
      strainSeries[cond] = Array.from(displayRow, (v, i) => ({ x: i * dt, y: v }));
      for (const v of displayRow) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }

      const pfire = computePFire(fullRow, manifest.encoding, nldGrad, nldShift, staFreq);
      pfireSeries[cond] = pfire.map((v, i) => ({ x: i * dt, y: v }));
    }

    strainChart.setDomains(strainXDomain, [yMin, yMax]);
    strainChart.setSeries(strainSeries.flap, strainSeries.rotate);

    pfireChart.setDomains(pfireXDomain, [0, 1]);
    pfireChart.setSeries(pfireSeries.flap, pfireSeries.rotate);
  }

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
    /** @param {number} frameMs - current animation time within one wingbeat, in ms */
    setPlayhead(frameMs) {
      strainChart.setPlayheadX(frameMs);
      pfireChart.setPlayheadX(frameMs);
    },
    getSensorIdx() {
      return sensorIdx;
    },
    dispose() {
      strainChart.dispose();
      pfireChart.dispose();
    },
  };
}
