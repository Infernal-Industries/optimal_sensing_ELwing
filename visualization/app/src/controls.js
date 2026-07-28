// controls.js — the dual bar+text-box parameter control (Plan §7). Every
// numeric parameter gets two coupled inputs with DIFFERENT allowed
// domains:
//   - the bar (slider) is capped to values renderable exactly with no
//     MATLAB round-trip -- client-computable (continuous) or precomputed
//     grid points (snaps to steps). Never waits, never approximates.
//   - the text box reaches further: for client-computable params it just
//     computes live for any value (createLiveDualControl); for
//     MATLAB-bound params it resolves through a ladder -- exact
//     precomputed match, else (no Tier 2 backend yet) snap to the nearest
//     precomputed value and notify (createResolutionLadderControl).

const INK_SECONDARY = "#c3c2b7";
const INK_MUTED = "#898781";

function row(labelText) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;min-width:220px;";
  const label = document.createElement("label");
  label.textContent = labelText;
  label.style.cssText = `color:${INK_SECONDARY};font:0.75rem system-ui,sans-serif;display:flex;justify-content:space-between;gap:6px;`;
  wrap.appendChild(label);
  const inputs = document.createElement("div");
  inputs.style.cssText = "display:flex;align-items:center;gap:6px;";
  wrap.appendChild(inputs);
  const notice = document.createElement("div");
  notice.style.cssText = `color:${INK_MUTED};font:0.68rem system-ui,sans-serif;min-height:1em;`;
  wrap.appendChild(notice);
  return { wrap, label, inputs, notice };
}

/**
 * Fully client-computable parameter (β, ω, α, speed, sensor count): slider
 * and number box share the same bounded range, both live (fire on every
 * input) -- encoding.js's caching keeps a full recompute fast enough
 * (~115ms) to apply directly on every drag frame, no confirm/Apply step
 * needed.
 * @param {HTMLElement} container
 * @param {{label:string, min:number, max:number, step:number, value:number,
 *   format?:(v:number)=>string, onChange:(v:number)=>void}} opts
 */
export function createLiveDualControl(container, opts) {
  const { label, min, max, step, onChange } = opts;
  const format = opts.format || ((v) => v.toFixed(2));
  let value = opts.value;

  const { wrap, label: labelEl, inputs } = row(label);
  const valueSpan = document.createElement("span");
  valueSpan.textContent = format(value);
  labelEl.appendChild(valueSpan);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  slider.style.flex = "1";

  const numberBox = document.createElement("input");
  numberBox.type = "number";
  numberBox.step = String(step);
  numberBox.value = String(value);
  numberBox.style.cssText = "width:70px;background:#12151c;color:#e6e6e6;border:1px solid #2c2c2a;border-radius:3px;padding:2px 4px;";

  inputs.appendChild(slider);
  inputs.appendChild(numberBox);
  container.appendChild(wrap);

  function apply(v, source) {
    value = v;
    valueSpan.textContent = format(value);
    if (source !== "slider") slider.value = String(value);
    if (source !== "number") numberBox.value = String(value);
    onChange(value);
  }

  slider.addEventListener("input", () => apply(Number(slider.value), "slider"));
  numberBox.addEventListener("change", () => {
    const v = Number(numberBox.value);
    if (Number.isFinite(v)) apply(v, "number");
  });

  return {
    setValue(v) {
      apply(v, null);
    },
    getValue() {
      return value;
    },
  };
}

/**
 * MATLAB-bound parameter (currently just wing stiffness E): slider snaps
 * to precomputed grid points only. Number box accepts any physical value
 * and resolves on commit (blur/Enter, not every keystroke):
 *   - exact precomputed match -> use it, no notice
 *   - no match (no Tier 2 backend built yet) -> snap to nearest
 *     precomputed value, show a notice with the delta, never silently
 *     substitute
 *   - below the hard physical floor -> reject outright with a notice,
 *     never snap (there is no valid nearest value below the floor)
 * @param {HTMLElement} container
 * @param {{label:string, points:number[], value:number, floor?:number,
 *   format?:(v:number)=>string, onChange:(v:number, isExact:boolean)=>void}} opts
 */
export function createResolutionLadderControl(container, opts) {
  const { label, points, floor, onChange } = opts;
  const format = opts.format || ((v) => v.toFixed(2));
  const sorted = points.slice().sort((a, b) => a - b);
  let value = opts.value;

  const { wrap, label: labelEl, inputs, notice } = row(label);
  const valueSpan = document.createElement("span");
  valueSpan.textContent = format(value);
  labelEl.appendChild(valueSpan);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(sorted.length - 1);
  slider.step = "1";
  slider.value = String(sorted.indexOf(value));
  slider.style.flex = "1";

  const numberBox = document.createElement("input");
  numberBox.type = "number";
  numberBox.step = "0.01";
  numberBox.value = String(value);
  numberBox.style.cssText = "width:70px;background:#12151c;color:#e6e6e6;border:1px solid #2c2c2a;border-radius:3px;padding:2px 4px;";

  inputs.appendChild(slider);
  inputs.appendChild(numberBox);
  container.appendChild(wrap);

  function nearest(v) {
    return sorted.reduce((best, p) => (Math.abs(p - v) < Math.abs(best - v) ? p : best), sorted[0]);
  }

  function applyExact(v) {
    value = v;
    valueSpan.textContent = format(value);
    slider.value = String(sorted.indexOf(value));
    numberBox.value = String(value);
    notice.textContent = "";
    onChange(value, true);
  }

  function resolveTyped(typed) {
    if (floor !== undefined && typed < floor) {
      notice.textContent = `Rejected: below the physical floor (${format(floor)}); the model doesn't converge there.`;
      numberBox.value = String(value); // revert display, keep last valid value active
      return;
    }
    if (sorted.includes(typed)) {
      applyExact(typed);
      return;
    }
    const snapped = nearest(typed);
    value = snapped;
    valueSpan.textContent = format(value);
    slider.value = String(sorted.indexOf(snapped));
    numberBox.value = String(snapped);
    notice.textContent = `Showing nearest precomputed value ${format(snapped)} — requested ${format(typed)} needs live MATLAB compute (not available: Tier 2 backend not yet built).`;
    onChange(value, false);
  }

  slider.addEventListener("input", () => applyExact(sorted[Number(slider.value)]));
  numberBox.addEventListener("change", () => {
    const v = Number(numberBox.value);
    if (Number.isFinite(v)) resolveTyped(v);
  });

  return {
    setValue(v) {
      applyExact(v);
    },
    getValue() {
      return value;
    },
  };
}
