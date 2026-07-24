// Diverging colormap for strain (a signed physical quantity -- tension vs.
// compression -- so this is a "polarity" job per the dataviz skill, not a
// magnitude/sequential one). Poles and midpoint are the skill's documented
// diverging pair (references/palette.md): blue <-> red, neutral gray at
// zero. Simple per-channel RGB lerp between stops -- adequate for a
// real-time vertex-color gradient; not claiming OKLab precision.

const NEG_POLE = [0x25, 0x6a, 0xbf]; // blue, palette.md sequential step 500
const MID = [0x38, 0x38, 0x35]; // neutral gray, dark-surface midpoint
const POS_POLE = [0xe3, 0x49, 0x48]; // red, categorical slot 8 (dark-surface variant #e66767 also reasonable; using light-mode hex for saturation)

function lerpRGB(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * @param {number} value - signed strain value
 * @param {number} maxAbs - normalization bound (max |value| across the dataset)
 * @returns {[number, number, number]} RGB in 0..1, for three.js Color.setRGB
 */
export function divergingColor(value, maxAbs) {
  const t = maxAbs > 0 ? Math.max(-1, Math.min(1, value / maxAbs)) : 0;
  const rgb255 = t < 0 ? lerpRGB(MID, NEG_POLE, -t) : lerpRGB(MID, POS_POLE, t);
  return [rgb255[0] / 255, rgb255[1] / 255, rgb255[2] / 255];
}
