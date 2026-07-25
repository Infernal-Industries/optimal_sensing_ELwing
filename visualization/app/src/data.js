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
//     Embedded directly in the JSON (small enough not to need the binary sidecar below).
//   - strain[sensorIdx][frame]           (MATLAB size: nSensorLocs x (strainLeadInFrames + strainFrames))
//     NATIVE resolution (== manifest.encoding.sampFreq), NOT downsampled -- deliberately a
//     different (finer) frame count than `deform`, because encoding.js needs enough time
//     resolution to reconvolve manifest.encoding.staFilt accurately. Do not assume
//     strain.length matches payload.frames -- use payload.strainFrames.
//     IMPORTANT: strain's length is strainLeadInFrames + strainFrames, NOT just
//     strainFrames -- the extra leading samples are required so encoding.js can compute
//     a MATLAB-conv('valid')-equivalent convolution against manifest.encoding.staFilt
//     that covers the ENTIRE displayed wingbeat (strainFrames output samples), not a
//     truncated one. See encoding.js's convValid().
//     NOT embedded in the JSON (Phase 5+, see plan §3/§4 sizing correction) -- shipped as
//     a binary `.bin` sidecar instead (payload.strainFile), float32, sensor-major (each
//     sensor's full time series contiguous), flap block then rotate block. loadSet()
//     fetches it and reconstructs payload.conditions.<cond>.strain as an array of
//     Float32Array views (zero-copy subarrays) into one shared buffer, so every consumer
//     (encoding.js, wing3d.js, wing2d.js, timelines.js, histogram.js) sees the exact same
//     strain[sensorIdx][frame] shape as before and needed no changes.
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
 * Reconstructs payload.conditions.{flap,rotate}.strain from the raw binary
 * sidecar -- float32, sensor-major, flap block then rotate block (see
 * exportForViz.m's writeStrainBinary(), which this must match exactly).
 * Returns zero-copy Float32Array views (subarray) into one shared buffer,
 * not plain-array copies -- consumers only ever read these, and typed
 * arrays support the same indexing/.length/.map/.slice/.reduce surface
 * every existing consumer (encoding.js etc.) already relies on.
 * @param {ArrayBuffer} buffer
 * @param {number} nSensorLocs
 * @param {number} nStrainTotal - strainLeadInFrames + strainFrames
 * @param {string} label - for error messages
 * @returns {{flap: Float32Array[], rotate: Float32Array[]}}
 */
function reconstructStrain(buffer, nSensorLocs, nStrainTotal, label) {
  const floatsPerCond = nSensorLocs * nStrainTotal;
  const expectedBytes = floatsPerCond * 2 * 4; // 2 conditions, 4 bytes/float32
  assert(
    buffer.byteLength === expectedBytes,
    `${label}: expected ${expectedBytes} bytes (${nSensorLocs} sensors x ${nStrainTotal} frames x 2 conditions x 4 bytes), got ${buffer.byteLength}`
  );

  function toRows(flat) {
    const rows = new Array(nSensorLocs);
    for (let i = 0; i < nSensorLocs; i++) {
      rows[i] = flat.subarray(i * nStrainTotal, (i + 1) * nStrainTotal);
    }
    return rows;
  }

  const flapView = new Float32Array(buffer, 0, floatsPerCond);
  const rotateView = new Float32Array(buffer, floatsPerCond * 4, floatsPerCond);
  return { flap: toRows(flapView), rotate: toRows(rotateView) };
}

/**
 * Fetches and structurally validates one set_<id>.json file plus its
 * binary strain sidecar, and merges the reconstructed strain arrays into
 * the returned payload (so callers see the same shape as when strain was
 * embedded directly in the JSON).
 * @param {string} baseUrl - directory containing manifest.json and the set files
 * @param {object} manifest - the already-loaded, already-validated manifest (for grid dims)
 * @param {string} setFile - the `file` field from a manifest.sets[] entry
 */
export async function loadSet(baseUrl, manifest, setFile) {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/${setFile}`;
  const res = await fetch(url);
  assert(res.ok, `Failed to fetch ${url}: HTTP ${res.status}`);
  const payload = await res.json();
  validateSetPayload(payload, manifest, url);

  const { chordElements, spanElements } = manifest.grid;
  const nSensorLocs = chordElements * spanElements;
  const nStrainTotal = payload.strainFrames + payload.strainLeadInFrames;

  const binUrl = `${base}/${payload.strainFile}`;
  const binRes = await fetch(binUrl);
  assert(binRes.ok, `Failed to fetch ${binUrl}: HTTP ${binRes.status}`);
  const buffer = await binRes.arrayBuffer();
  const strain = reconstructStrain(buffer, nSensorLocs, nStrainTotal, binUrl);
  payload.conditions.flap.strain = strain.flap;
  payload.conditions.rotate.strain = strain.rotate;

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
  assert(
    typeof payload.strainLeadInFrames === "number" && payload.strainLeadInFrames >= 0,
    `${label}.strainLeadInFrames missing or invalid`
  );
  assert(typeof payload.period_ms === "number" && payload.period_ms > 0, `${label}.period_ms missing or invalid`);
  assert(
    typeof payload.strainFile === "string" && payload.strainFile.length > 0,
    `${label}.strainFile missing or invalid`
  );
  const nFrames = payload.frames;

  assert(payload.conditions, `${label}.conditions missing`);
  for (const cond of ["flap", "rotate"]) {
    const c = payload.conditions[cond];
    assert(c, `${label}.conditions.${cond} missing`);

    // deform[frame][chordIdx][spanIdx] -- animation resolution (payload.frames)
    // Only the innermost (spanIdx) level is numeric; outer levels are arrays of arrays.
    // strain is NOT checked here -- it isn't embedded in the JSON (see file header);
    // reconstructStrain()'s byte-length assertion is what validates it, after loadSet()
    // fetches the binary sidecar referenced by payload.strainFile.
    isArray(c.deform, nFrames, `${label}.conditions.${cond}.deform`);
    isArray(c.deform[0], chordElements, `${label}.conditions.${cond}.deform[0]`);
    isNumberArray(c.deform[0][0], spanElements, `${label}.conditions.${cond}.deform[0][0]`);
    isNumberArray(
      c.deform[nFrames - 1][chordElements - 1],
      spanElements,
      `${label}.conditions.${cond}.deform[last][last]`
    );
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

/**
 * Converts a MATLAB 1-based linear sensor index (column-major over
 * [chordElements, spanElements], i.e. chordElements varies fastest -- see
 * wing3d.js's indexing comment / ind2sub usage in exportForViz.m) to
 * 0-based {chordIdx, spanIdx} grid coordinates. Shared by wing3d.js and
 * wing2d.js so both overlay optimal sensors at the same physical location.
 * @param {number} idx1 - 1-based linear sensor index
 * @param {number} chordElements
 * @returns {{chordIdx: number, spanIdx: number}}
 */
export function sensorIndexToChordSpan(idx1, chordElements) {
  const idx0 = idx1 - 1;
  return { chordIdx: idx0 % chordElements, spanIdx: Math.floor(idx0 / chordElements) };
}

export { SchemaError };
