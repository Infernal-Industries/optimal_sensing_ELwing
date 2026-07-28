// encoding.js — JS port of the linear-nonlinear encoding in
// neuralTransformationOfData.m: strain -> convolve with the STA filter ->
// sigmoid nonlinearity -> P(fire). Runs entirely client-side (Plan §2's
// "fast knob" insight) so threshold/slope/filter changes are instant, no
// backend round trip.
//
// Ported math (neuralTransformationOfData.m):
//   strainConv = conv(strain, staFilt, 'valid')
//   X = nldFunc( strainConv / normalizeVal / subSamp )
//   nldFunc(s) = ( 1/(1+exp(-nldGrad*(s-nldShift))) - 0.5 ) + 0.5
//              = 1/(1+exp(-nldGrad*(s-nldShift)))   [algebraically identical;
//                the -0.5+0.5 in the original is a no-op, kept here only as
//                a comment for traceability back to the source]

/**
 * Replicates MATLAB's conv(x, h, 'valid') exactly -- true convolution
 * (flips h), keeping only fully-overlapping output points.
 * @param {number[]} x - length Lx
 * @param {number[]} h - length Lh, Lx >= Lh required
 * @returns {number[]} length Lx - Lh + 1
 */
export function convValid(x, h) {
  const Lx = x.length;
  const Lh = h.length;
  if (Lx < Lh) throw new Error(`convValid: signal (${Lx}) shorter than filter (${Lh})`);
  const outLen = Lx - Lh + 1;
  const out = new Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    for (let k = 0; k < Lh; k++) {
      sum += x[i + k] * h[Lh - 1 - k];
    }
    out[i] = sum;
  }
  return out;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Ports the STA filter construction from neuralTransformationOfData.m /
 * exportForViz.m's encodingConstants() exactly, so `staFreq` (the omega /
 * filter-frequency control, Plan §7) can be a live client-side knob rather
 * than fixed to whatever value the MATLAB export used. Cross-checked
 * numerically against the exported manifest.encoding.staFilt (built with
 * the same inputs) before this was trusted -- see scripts/ or commit
 * history for the check.
 *
 *   staT = -19:(1000/sampFreq):0
 *   f(t) = cos(staFreq*(t+staDelay)) * exp(-(t+staDelay)^2/staWidth^2)
 *   f -= mean(f); if staFreq < 0.1, f = ones(...)
 *   staFilt = fliplr(f / sqrt(sum(f.^2)) / 0.2003 * 1000/sampFreq)
 *
 * @param {number} staFreq
 * @param {number} staWidth
 * @param {number} staDelay
 * @param {number} sampFreq
 * @returns {number[]} filter taps, ready for convValid (already "pre-flipped"
 *   to match MATLAB's conv() convention, same as the exported staFilt)
 */
export function buildSTAFilter(staFreq, staWidth, staDelay, sampFreq) {
  const step = 1000 / sampFreq;
  const nPts = Math.floor(19 / step) + 1;
  const staT = Array.from({ length: nPts }, (_, i) => -19 + i * step);

  let f = staT.map((t) => Math.cos(staFreq * (t + staDelay)) * Math.exp(-((t + staDelay) ** 2) / staWidth ** 2));
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  f = f.map((v) => v - mean);
  if (staFreq < 0.1) f = f.map(() => 1);

  const sumSq = f.reduce((a, b) => a + b * b, 0);
  const k = Math.sqrt(1 / sumSq);
  const scaled = f.map((v) => (k * v) / 0.2003 * (1000 / sampFreq));
  return scaled.slice().reverse(); // fliplr
}

/**
 * Computes P(fire) over time for one sensor's strain row.
 * @param {number[]} strainRow - length strainLeadInFrames + strainFrames (see data.js)
 * @param {object} enc - manifest.encoding
 * @param {number} [nldGrad] - override manifest.encoding.nldGrad (the alpha/slope control)
 * @param {number} [nldShift] - override manifest.encoding.nldShift (the beta/threshold control)
 * @param {number} [staFreq] - override manifest.encoding.staFreq (the omega/filter-frequency control);
 *   passing a value different from enc.staFreq rebuilds the filter live via buildSTAFilter
 *   instead of reusing the exported (fixed) enc.staFilt taps.
 * @param {number[]} [staFiltOverride] - precomputed filter taps to use directly, skipping the
 *   staFreq-vs-enc.staFreq check/rebuild above. Callers that process many rows with the same
 *   staFreq (computePFireAll) should build the filter once and pass it here, rather than
 *   rebuilding it from scratch on every row.
 * @returns {number[]} length strainFrames, P(fire) in [0,1]
 */
export function computePFire(
  strainRow,
  enc,
  nldGrad = enc.nldGrad,
  nldShift = enc.nldShift,
  staFreq = enc.staFreq,
  staFiltOverride
) {
  const staFilt = staFiltOverride ?? (staFreq === enc.staFreq ? enc.staFilt : buildSTAFilter(staFreq, enc.staWidth, enc.staDelay, enc.sampFreq));
  const filtered = convValid(strainRow, staFilt);
  const norm = enc.normalizeVal * enc.subSamp;
  return filtered.map((v) => sigmoid(nldGrad * (v / norm - nldShift)));
}

// wing3d.js and wing2d.js both call computePFireAll on the exact same
// payload.conditions.<cond>.strain array with the exact same (nldGrad,
// nldShift, staFreq) whenever the threshold is applied -- computing the
// identical ~1300-sensor result twice back-to-back. Cache the last result per
// strain array (WeakMap so it's naturally dropped when a dataset reload
// replaces the array) and reuse it when params haven't changed since.
const pfireAllCache = new WeakMap();

/**
 * Convenience: P(fire) for every sensor in a condition's strain block. Builds the STA filter
 * ONCE (not once per sensor row -- buildSTAFilter is nontrivial, ~190 trig/exp calls, and with
 * ~1300 sensors this was previously rebuilding the identical filter over a thousand times per
 * call when staFreq differed from the exported default). Also memoizes the whole result per
 * strain array + params (see pfireAllCache above).
 * @param {number[][]} strain - payload.conditions.<cond>.strain
 * @param {object} enc - manifest.encoding
 * @param {number} [nldGrad]
 * @param {number} [nldShift]
 * @param {number} [staFreq]
 * @returns {number[][]} [sensorIdx][frame]
 */
export function computePFireAll(strain, enc, nldGrad = enc.nldGrad, nldShift = enc.nldShift, staFreq = enc.staFreq) {
  const cached = pfireAllCache.get(strain);
  if (cached && cached.nldGrad === nldGrad && cached.nldShift === nldShift && cached.staFreq === staFreq) {
    return cached.result;
  }
  const staFilt = staFreq === enc.staFreq ? enc.staFilt : buildSTAFilter(staFreq, enc.staWidth, enc.staDelay, enc.sampFreq);
  const result = strain.map((row) => computePFire(row, enc, nldGrad, nldShift, staFreq, staFilt));
  pfireAllCache.set(strain, { nldGrad, nldShift, staFreq, result });
  return result;
}

/**
 * Draws one probabilistic spike train from a P(fire) curve, exactly
 * replicating convertProbFiringToSpikes.m's refractory-period logic: at
 * each sample, spike if a uniform random draw is below P(fire) at that
 * sample, then suppress (zero) the probability for refPerSamples samples
 * afterward -- on a working copy, so the original pfire array (and the
 * displayed P(fire) curve) is untouched.
 * @param {number[]} pfire
 * @param {number} refPerSamples - refractory period in samples (native resolution)
 * @returns {number[]} 0/1 spike indicator, same length as pfire
 */
export function generateSpikeTrain(pfire, refPerSamples) {
  const n = pfire.length;
  const spikes = new Array(n).fill(0);
  const temp = pfire.slice();
  for (let t = 0; t < n; t++) {
    if (Math.random() < temp[t]) {
      spikes[t] = 1;
      const end = Math.min(t + refPerSamples, n);
      for (let k = t + 1; k < end; k++) temp[k] = 0;
    }
  }
  return spikes;
}

/**
 * Peristimulus time histogram: repeats generateSpikeTrain nReps times
 * (simulating that many wingbeats, matching paper Fig 2E's "summarizing
 * spike timing over hundreds of wingbeats") and sums spike counts per
 * sample -- a per-time-bin spike count, ready to plot as a bar chart.
 * @param {number[]} pfire
 * @param {number} refPerSamples
 * @param {number} nReps
 * @returns {number[]} spike counts per sample, same length as pfire
 */
export function samplePSTH(pfire, refPerSamples, nReps) {
  const counts = new Array(pfire.length).fill(0);
  for (let r = 0; r < nReps; r++) {
    const spikes = generateSpikeTrain(pfire, refPerSamples);
    for (let t = 0; t < spikes.length; t++) counts[t] += spikes[t];
  }
  return counts;
}
