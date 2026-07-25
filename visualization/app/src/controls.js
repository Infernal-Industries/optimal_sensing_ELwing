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

// `boxed` (used for confirm-gated controls) draws a border around the whole
// row -- slider, number box, Apply button, and any snap/reject notice -- so
// it reads visually as one "commits together, on Apply" unit, distinct from
// the always-live controls around it.
function row(labelText, boxed = false) {
  const wrap = document.createElement("div");
  wrap.style.cssText = boxed
    ? "display:flex;flex-direction:column;gap:2px;min-width:220px;border:1px solid #3d5166;border-radius:6px;padding:6px 8px;background:#161a22;"
    : "display:flex;flex-direction:column;gap:2px;min-width:220px;";
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

// Confirm-gated controls (opts.confirm) stage slider/number-box edits into the
// displayed value immediately (cheap) but withhold the expensive onChange call
// until this Apply button is clicked -- for params whose consumer recompute is
// too heavy to run on every drag-frame 'input' event.
function makeApplyButton(onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Apply";
  btn.style.cssText =
    "background:#2c3e50;color:#e6e6e6;border:1px solid #3d5166;border-radius:3px;padding:2px 8px;font:0.7rem system-ui,sans-serif;cursor:pointer;flex-shrink:0;";
  btn.addEventListener("click", onClick);
  return btn;
}

/**
 * Fully client-computable parameter (β, ω, α, speed, sensor count): slider
 * and number box share the same bounded range.
 * @param {HTMLElement} container
 * @param {{label:string, min:number, max:number, step:number, value:number,
 *   format?:(v:number)=>string, onChange:(v:number)=>void, confirm?:boolean}} opts
 *   confirm (default false): if true, dragging the slider/editing the number box only
 *   updates the displayed value -- onChange (and whatever expensive recompute it
 *   triggers) only fires when the Apply button next to the inputs is clicked. Use for
 *   params whose consumers are too expensive to recompute on every drag-frame 'input'
 *   event (e.g. β/α/ω, which trigger a full P(fire) recompute over ~1300 sensors). Also
 *   draws a bordered box around the control and makes the slider snap in coarse steps
 *   (per `step`) -- the number box stays free-entry at any precision regardless, so
 *   exact/in-between values are only reachable by typing, never by dragging.
 */
export function createLiveDualControl(container, opts) {
  const { label, min, max, step, onChange, confirm = false } = opts;
  const format = opts.format || ((v) => v.toFixed(2));
  let value = opts.value;

  const { wrap, label: labelEl, inputs } = row(label, confirm);
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
  numberBox.step = "any"; // free precision regardless of the slider's snap granularity
  numberBox.value = String(value);
  numberBox.style.cssText = "width:70px;background:#12151c;color:#e6e6e6;border:1px solid #2c2c2a;border-radius:3px;padding:2px 4px;";

  inputs.appendChild(slider);
  inputs.appendChild(numberBox);
  if (confirm) inputs.appendChild(makeApplyButton(() => commit()));
  container.appendChild(wrap);

  // stage() updates the displayed value only (cheap: DOM text/attrs). commit()
  // additionally fires onChange. Non-confirm controls stage+commit together on
  // every input; confirm controls stage on every input but only commit on Apply.
  function stage(v, source) {
    value = v;
    valueSpan.textContent = format(value);
    if (source !== "slider") slider.value = String(value);
    if (source !== "number") numberBox.value = String(value);
  }
  function commit() {
    onChange(value);
  }
  function apply(v, source) {
    stage(v, source);
    commit();
  }

  slider.addEventListener("input", () => (confirm ? stage(Number(slider.value), "slider") : apply(Number(slider.value), "slider")));
  numberBox.addEventListener("change", () => {
    const v = Number(numberBox.value);
    if (!Number.isFinite(v)) return;
    if (confirm) stage(v, "number");
    else apply(v, "number");
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
 *   format?:(v:number)=>string, onChange:(v:number, isExact:boolean)=>void, confirm?:boolean}} opts
 *   confirm (default false): if true, moving the slider only updates the displayed value
 *   (and any snap/reject notice) -- onChange only fires on the Apply button. Use when
 *   onChange triggers something too expensive to run per grid-point while dragging
 *   (e.g. wing stiffness E, which reloads a whole precomputed dataset over the network).
 */
export function createResolutionLadderControl(container, opts) {
  const { label, points, floor, onChange, confirm = false } = opts;
  const format = opts.format || ((v) => v.toFixed(2));
  const sorted = points.slice().sort((a, b) => a - b);
  let value = opts.value;
  let pendingExact = true; // isExact flag for whatever `value` currently holds, applied at commit time

  const { wrap, label: labelEl, inputs, notice } = row(label, confirm);
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
  numberBox.step = "any"; // free precision -- exact/approximate values only reachable by typing
  numberBox.value = String(value);
  numberBox.style.cssText = "width:70px;background:#12151c;color:#e6e6e6;border:1px solid #2c2c2a;border-radius:3px;padding:2px 4px;";

  inputs.appendChild(slider);
  inputs.appendChild(numberBox);
  if (confirm) inputs.appendChild(makeApplyButton(() => onChange(value, pendingExact)));
  container.appendChild(wrap);

  function nearest(v) {
    return sorted.reduce((best, p) => (Math.abs(p - v) < Math.abs(best - v) ? p : best), sorted[0]);
  }

  function stageExact(v) {
    value = v;
    pendingExact = true;
    valueSpan.textContent = format(value);
    slider.value = String(sorted.indexOf(value));
    numberBox.value = String(value);
    notice.textContent = "";
  }

  function applyExact(v) {
    stageExact(v);
    onChange(value, true);
  }

  function resolveTyped(typed) {
    if (floor !== undefined && typed < floor) {
      notice.textContent = `Rejected: below the physical floor (${format(floor)}); the model doesn't converge there.`;
      numberBox.value = String(value); // revert display, keep last valid value active
      return;
    }
    if (sorted.includes(typed)) {
      if (confirm) stageExact(typed);
      else applyExact(typed);
      return;
    }
    const snapped = nearest(typed);
    value = snapped;
    pendingExact = false;
    valueSpan.textContent = format(value);
    slider.value = String(sorted.indexOf(snapped));
    numberBox.value = String(snapped);
    notice.textContent = `Showing nearest precomputed value ${format(snapped)} — requested ${format(typed)} needs live MATLAB compute (not available: Tier 2 backend not yet built).`;
    if (!confirm) onChange(value, false);
  }

  slider.addEventListener("input", () => {
    const v = sorted[Number(slider.value)];
    if (confirm) stageExact(v);
    else applyExact(v);
  });
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
