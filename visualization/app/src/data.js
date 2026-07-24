// data.js — loads and structurally validates the exported precomputed data
// (visualization/export/exportForViz.m), per the schema in
// LLM_context/VISUALIZATION_PLAN.md, Section 3.
//
// This is real, load-bearing front-end code (not a throwaway test script):
// later phases (wing3d.js, timelines.js, ...) import loadManifest/loadSet
// from here. For Phase 0, validate.html uses it standalone, with no build
// step, to confirm exportForViz.m's output actually matches what the
// front-end expects to read.
//
// Array-shape note (matches MATLAB's jsonencode dimension order exactly):
//   - deform[frame][chordIdx][spanIdx]   (MATLAB size: payload.frames x chordElements x spanElements)
//     Downsampled resolution (default 90/wingbeat) -- fine for the 3D animation loop.
//   - strain[sensorIdx][frame]           (MATLAB size: nSensorLocs x payload.strainFrames)
//     NATIVE resolution (== manifest.encoding.sampFreq), NOT downsampled -- deliberately a
//     different (finer) frame count than `deform`, because encoding.js needs enough time
//     resolution to reconvolve manifest.encoding.staFilt accurately. Do not assume
//     strain.length matches payload.frames -- use payload.strainFrames.
//   - optimalSensors.top1  -> number (1-based linear index into the chord x span grid)
//   - optimalSensors.top5  -> number[5]
//   - optimalSensors.top10 -> number[10]
//   - spanHistogram        -> number[spanElements]
//   - accuracyBySensorCount -> number[10], accuracy using the top N sensors, N=1..10

class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
  }
}

function assert(cond, message) {
  if (!cond) throw new SchemaError(message);
}

function isArray(x, expectedLength, path) {
  assert(Array.isArray(x), `${path}: expected an array, got ${typeof x}`);
  if (expectedLength !== undefined) {
    assert(
      x.length === expectedLength,
      `${path}: expected length ${expectedLength}, got ${x.length}`
    );
  }
}

// For leaf (1D) arrays only -- asserts array-ness/length AND that every
// entry is a finite number. Do not call this on an array of sub-arrays
// (use isArray for those levels; only the innermost dimension is numeric).
function isNumberArray(x, expectedLength, path) {
  isArray(x, expectedLength, path);
  assert(
    x.every((v) => typeof v === "number" && Number.isFinite(v)),
    `${path}: expected all entries to be finite numbers`
  );
}

/** Fetches and structurally validates manifest.json. */
export async function loadManifest(baseUrl) {
  const url = `${baseUrl.replace(/\/$/, "")}/manifest.json`;
  const res = await fetch(url);
  assert(res.ok, `Failed to fetch ${url}: HTTP ${res.status}`);
  const manifest = await res.json();

  assert(manifest.grid, "manifest.grid missing");
  for (const key of ["chordElements", "spanElements", "chord_mm", "span_mm"]) {
    assert(
      typeof manifest.grid[key] === "number",
      `manifest.grid.${key} missing or not a number`
    );
  }

  assert(manifest.encoding, "manifest.encoding missing");
  for (const key of [
    "sampFreq",
    "flapFrequency",
    "refPer",
    "nldGrad",
    "nldShift",
    "staFreq",
    "staWidth",
    "staDelay",
    "normalizeVal",
  ]) {
    assert(
      typeof manifest.encoding[key] === "number",
      `manifest.encoding.${key} missing or not a number`
    );
  }
  assert(
    Array.isArray(manifest.encoding.staFilt) && manifest.encoding.staFilt.length > 0,
    "manifest.encoding.staFilt missing or empty"
  );

  assert(
    Array.isArray(manifest.sets) && manifest.sets.length > 0,
    "manifest.sets missing or empty"
  );
  for (const [i, set] of manifest.sets.entries()) {
    for (const key of ["id", "stiffnessFactor", "axis", "accuracy", "file"]) {
      assert(set[key] !== undefined, `manifest.sets[${i}].${key} missing`);
    }
  }

  return manifest;
}

/**
 * Fetches and structurally validates one set_<id>.json file.
 * @param {string} baseUrl - directory containing manifest.json and the set files
 * @param {object} manifest - the already-loaded, already-validated manifest (for grid dims)
 * @param {string} setFile - the `file` field from a manifest.sets[] entry
 */
export async function loadSet(baseUrl, manifest, setFile) {
  const url = `${baseUrl.replace(/\/$/, "")}/${setFile}`;
  const res = await fetch(url);
  assert(res.ok, `Failed to fetch ${url}: HTTP ${res.status}`);
  const payload = await res.json();
  validateSetPayload(payload, manifest, url);
  return payload;
}

/** Throws a SchemaError with a descriptive message on any structural mismatch. */
export function validateSetPayload(payload, manifest, label = "payload") {
  const { chordElements, spanElements } = manifest.grid;
  const nSensorLocs = chordElements * spanElements;

  assert(typeof payload.frames === "number" && payload.frames > 0, `${label}.frames missing or invalid`);
  assert(
    typeof payload.strainFrames === "number" && payload.strainFrames > 0,
    `${label}.strainFrames missing or invalid`
  );
  assert(typeof payload.period_ms === "number" && payload.period_ms > 0, `${label}.period_ms missing or invalid`);
  const nFrames = payload.frames;
  const nStrainFrames = payload.strainFrames;

  assert(payload.conditions, `${label}.conditions missing`);
  for (const cond of ["flap", "rotate"]) {
    const c = payload.conditions[cond];
    assert(c, `${label}.conditions.${cond} missing`);

    // deform[frame][chordIdx][spanIdx] -- animation resolution (payload.frames)
    // Only the innermost (spanIdx) level is numeric; outer levels are arrays of arrays.
    isArray(c.deform, nFrames, `${label}.conditions.${cond}.deform`);
    isArray(c.deform[0], chordElements, `${label}.conditions.${cond}.deform[0]`);
    isNumberArray(c.deform[0][0], spanElements, `${label}.conditions.${cond}.deform[0][0]`);
    isNumberArray(
      c.deform[nFrames - 1][chordElements - 1],
      spanElements,
      `${label}.conditions.${cond}.deform[last][last]`
    );

    // strain[sensorIdx][frame] -- native/encoding resolution (payload.strainFrames), NOT payload.frames
    isArray(c.strain, nSensorLocs, `${label}.conditions.${cond}.strain`);
    isNumberArray(c.strain[0], nStrainFrames, `${label}.conditions.${cond}.strain[0]`);
    isNumberArray(c.strain[nSensorLocs - 1], nStrainFrames, `${label}.conditions.${cond}.strain[last]`);
  }

  assert(payload.optimalSensors, `${label}.optimalSensors missing`);
  assert(typeof payload.optimalSensors.top1 === "number", `${label}.optimalSensors.top1 missing or invalid`);
  isNumberArray(payload.optimalSensors.top5, 5, `${label}.optimalSensors.top5`);
  isNumberArray(payload.optimalSensors.top10, 10, `${label}.optimalSensors.top10`);
  for (const idx of payload.optimalSensors.top10) {
    assert(
      idx >= 1 && idx <= nSensorLocs,
      `${label}.optimalSensors: sensor index ${idx} out of range [1, ${nSensorLocs}]`
    );
  }

  isNumberArray(payload.spanHistogram, spanElements, `${label}.spanHistogram`);
  isNumberArray(payload.accuracyBySensorCount, 10, `${label}.accuracyBySensorCount`);
  for (const acc of payload.accuracyBySensorCount) {
    assert(acc >= 0 && acc <= 1, `${label}.accuracyBySensorCount: value ${acc} outside [0,1]`);
  }
}

export { SchemaError };
