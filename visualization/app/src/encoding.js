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
