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

// Single-line control row for the compact top bar: label, then slider+numberbox
// (appended into `inputs`), then a small "ⓘ" notice indicator that only takes
// space when it actually has something to say (its message goes in the native
// `title` tooltip, not inline text -- a full sentence per control would blow
// the top bar's vertical budget across 4+ controls).
function row(labelText) {
  const wrap = document.createElement("div");
  wrap.style.cssText = `display:flex;align-items:center;gap:6px;font:0.72rem system-ui,sans-serif;color:${INK_SECONDARY};white-space:nowrap;`;
  const label = document.createElement("span");
  label.textContent = labelText;
  wrap.appendChild(label);
  const inputs = document.createElement("div");
  inputs.style.cssText = "display:flex;align-items:center;gap:4px;";
  wrap.appendChild(inputs);
  const notice = document.createElement("span");
  notice.textContent = "ⓘ";
  notice.style.cssText = `display:none;color:${INK_MUTED};cursor:help;font-size:0.85rem;`;
  wrap.appendChild(notice);
  return { wrap, label, inputs, notice };
}

// Shows/hides the row's "ⓘ" indicator and sets its tooltip text.
function setNotice(notice, message) {
  notice.title = message || "";
  notice.style.display = message ? "inline" : "none";
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
  let value = opts.value;

  const { wrap, inputs } = row(label);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);
  slider.style.width = "80px";

  const numberBox = document.createElement("input");
  numberBox.type = "number";
  numberBox.step = String(step);
  numberBox.value = String(value);
  numberBox.style.cssText = "width:52px;background:#12151c;color:#e6e6e6;border:1px solid #2c2c2a;border-radius:3px;padding:2px 4px;font:inherit;";

  inputs.appendChild(slider);
  inputs.appendChild(numberBox);
  container.appendChild(wrap);

  function apply(v, source) {
    value = v;
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

  const { wrap, inputs, notice } = row(label);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(sorted.length - 1);
  slider.step = "1";
  slider.value = String(sorted.indexOf(value));
  slider.style.width = "80px";

  const numberBox = document.createElement("input");
  numberBox.type = "number";
  numberBox.step = "0.01";
  numberBox.value = String(value);
  numberBox.style.cssText = "width:52px;background:#12151c;color:#e6e6e6;border:1px solid #2c2c2a;border-radius:3px;padding:2px 4px;font:inherit;";

  inputs.appendChild(slider);
  inputs.appendChild(numberBox);
  container.appendChild(wrap);

  function nearest(v) {
    return sorted.reduce((best, p) => (Math.abs(p - v) < Math.abs(best - v) ? p : best), sorted[0]);
  }

  function applyExact(v) {
    value = v;
    slider.value = String(sorted.indexOf(value));
    numberBox.value = String(value);
    setNotice(notice, "");
    onChange(value, true);
  }

  function resolveTyped(typed) {
    if (floor !== undefined && typed < floor) {
      setNotice(notice, `Rejected: below the physical floor (${format(floor)}); the model doesn't converge there.`);
      numberBox.value = String(value); // revert display, keep last valid value active
      return;
    }
    if (sorted.includes(typed)) {
      applyExact(typed);
      return;
    }
    const snapped = nearest(typed);
    value = snapped;
    slider.value = String(sorted.indexOf(snapped));
    numberBox.value = String(snapped);
    setNotice(notice, `Showing nearest precomputed value ${format(snapped)} — requested ${format(typed)} needs live MATLAB compute (not available: Tier 2 backend not yet built).`);
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
