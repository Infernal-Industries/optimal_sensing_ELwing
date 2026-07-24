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
 * Computes P(fire) over time for one sensor's strain row.
 * @param {number[]} strainRow - length strainLeadInFrames + strainFrames (see data.js)
 * @param {object} enc - manifest.encoding
 * @param {number} [nldGrad] - override manifest.encoding.nldGrad (the alpha/slope control)
 * @param {number} [nldShift] - override manifest.encoding.nldShift (the beta/threshold control)
 * @returns {number[]} length strainFrames, P(fire) in [0,1]
 */
export function computePFire(strainRow, enc, nldGrad = enc.nldGrad, nldShift = enc.nldShift) {
  const filtered = convValid(strainRow, enc.staFilt);
  const norm = enc.normalizeVal * enc.subSamp;
  return filtered.map((v) => sigmoid(nldGrad * (v / norm - nldShift)));
}

/**
 * Convenience: P(fire) for every sensor in a condition's strain block.
 * @param {number[][]} strain - payload.conditions.<cond>.strain
 * @param {object} enc - manifest.encoding
 * @param {number} [nldGrad]
 * @param {number} [nldShift]
 * @returns {number[][]} [sensorIdx][frame]
 */
export function computePFireAll(strain, enc, nldGrad, nldShift) {
  return strain.map((row) => computePFire(row, enc, nldGrad, nldShift));
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
