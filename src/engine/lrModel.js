// Lightroom-matched slider models, measured with the photo-studio calibration kit (Oct 2026)
// and shared with LumaGrader Photo Studio (same tables: lrModelData.js is generated from the
// Mac app's data files by tools/calibration/export_js.py).
//
//  • Exposure, Contrast, Whites, Blacks → one tone curve on display values (sRGB-encoded),
//    applied hue-preserving on ProPhoto RGB channels (the curve moves the largest and smallest
//    channel; the middle one keeps its position), then clipped per channel like Lightroom.
//    Exposure = un-render with a fixed curve H, ×2^EV, re-render: x → H(H⁻¹(x) + EV).
//  • Shadows, Highlights → a gain in EV looked up by the pixel's zone value
//    (mix of the edge-aware local base and the pixel itself); saturation follows less than a
//    plain gain would (chroma × 2^(−β·gain)).
//  • Saturation (and Lightroom's Calibration, for presets) → 3×3 matrices on linear RGB.
//  • Color Mixer (HSL) → Oklab hue shift / chroma / lightness by the pixel's hue and chroma.
import { LR_MODEL } from './lrModelData'

const M = LR_MODEL
export const TONE_LUT_SIZE = 1024
export const ZONE_LUT_SIZE = 256
export const HSL_TABLE_WIDTH = 361
export const HSL_TABLE_ROWS = 16
export const HSL_MAX_CHROMA = 0.3
export const ZONE = { mix: M.local.zoneMix, shadowsChroma: M.local.shadowsChroma, highlightsChroma: M.local.highlightsChroma, range: M.local.zoneRange }

const clamp01 = (x) => Math.min(1, Math.max(0, x))

/** Piecewise-linear interpolation; xs ascending, clamped outside. */
function interp(x, xs, ys) {
  const n = xs.length
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n - 1]) return ys[n - 1]
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] <= x) lo = mid
    else hi = mid
  }
  const span = xs[hi] - xs[lo]
  return ys[lo] + (ys[hi] - ys[lo]) * (span > 0 ? (x - xs[lo]) / span : 0)
}

/** An evenly spaced table over 0…1, linearly interpolated. */
function sample(table, x) {
  const p = clamp01(x) * (table.length - 1)
  const i = Math.min(Math.floor(p), table.length - 2)
  const t = p - i
  return table[i] * (1 - t) + table[i + 1] * t
}

/** Table value for `amount` between the measured amounts (0 = no effect). */
function sliderOffset(table, x, amount) {
  if (!amount) return 0
  const { amounts, offsets } = table
  const a = Math.min(Math.max(amount, amounts[0]), amounts[amounts.length - 1])
  let i = 0
  while (i < amounts.length - 2 && a > amounts[i + 1]) i++
  const span = amounts[i + 1] - amounts[i]
  const t = span > 0 ? (a - amounts[i]) / span : 0
  return sample(offsets[i], x) * (1 - t) + sample(offsets[i + 1], x) * t
}

// ---- Global tone ------------------------------------------------------------------------

export function exposureCurve(x, ev) {
  if (!ev) return x
  const { exposureStops: U, exposureCurve: H } = M.tone
  return interp(interp(clamp01(x), H, U) + ev, U, H)
}

/** Display value in → out (0…1) for Exposure, Blacks, Whites, Contrast (in that order). */
export function toneValue(x, { exposure = 0, blacks = 0, whites = 0, contrast = 0 }) {
  let v = exposureCurve(clamp01(x), exposure)
  const T = M.tone.sliders
  if (blacks) v += sliderOffset(T.blacks, clamp01(v), blacks)
  if (whites) v += sliderOffset(T.whites, clamp01(v), whites)
  if (contrast) v += sliderOffset(T.contrast, clamp01(v), contrast)
  return clamp01(v)
}

export const isGlobalToneActive = (t) => !!(t.exposure || t.contrast || t.whites || t.blacks)

export function buildToneLUT(t) {
  const lut = new Float32Array(TONE_LUT_SIZE)
  for (let i = 0; i < TONE_LUT_SIZE; i++) lut[i] = toneValue(i / (TONE_LUT_SIZE - 1), t)
  return lut
}

/** LUT lookup with the slope of the last step above 1 (RAW headroom). */
export function sampleToneLUT(lut, x) {
  const n = lut.length - 1
  if (x <= 1) return sample(lut, Math.max(0, x))
  return lut[n] + (x - 1) * (lut[n] - lut[n - 1]) * n
}

// sRGB ↔ ProPhoto (linear, Bradford D65 → D50)
const S2PP = [0.5292804, 0.330153, 0.1405666, 0.0983662, 0.873464, 0.0281698, 0.0168753, 0.1176594, 0.8654652]
const PP2S = [2.0343675, -0.7276345, -0.3067331, -0.2288268, 1.2317534, -0.0029266, -0.0085584, -0.1532682, 1.1618266]
const enc = (y) => (y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055)
const dec = (p) => (p <= 0.04045 ? p / 12.92 : Math.pow((p + 0.055) / 1.055, 2.4))

/** Hue-preserving tone curve on linear sRGB → linear sRGB (clipped to 0…1). */
export function toneRGB(r, g, b, lut) {
  const p = [
    enc(Math.max(0, S2PP[0] * r + S2PP[1] * g + S2PP[2] * b)),
    enc(Math.max(0, S2PP[3] * r + S2PP[4] * g + S2PP[5] * b)),
    enc(Math.max(0, S2PP[6] * r + S2PP[7] * g + S2PP[8] * b)),
  ]
  const hi = Math.max(p[0], p[1], p[2]), lo = Math.min(p[0], p[1], p[2])
  const nhi = sampleToneLUT(lut, hi), nlo = sampleToneLUT(lut, lo)
  const o = p.map((e) => (hi - lo > 1e-6 ? nlo + ((nhi - nlo) * (e - lo)) / (hi - lo) : nhi))
  const l = o.map((e) => dec(Math.max(0, e)))
  return [
    clamp01(PP2S[0] * l[0] + PP2S[1] * l[1] + PP2S[2] * l[2]),
    clamp01(PP2S[3] * l[0] + PP2S[4] * l[1] + PP2S[5] * l[2]),
    clamp01(PP2S[6] * l[0] + PP2S[7] * l[1] + PP2S[8] * l[2]),
  ]
}

/**
 * Point curves (RGB + R/G/B, 256-entry 0…255 tables) on ProPhoto RGB (sRGB-encoded) channels,
 * like Lightroom. In and out: sRGB-encoded 0…1.
 */
export function pointCurvesProPhoto(r, g, b, luts) {
  const lr = dec(r), lg = dec(g), lb = dec(b)
  const p = [
    enc(clamp01(S2PP[0] * lr + S2PP[1] * lg + S2PP[2] * lb)),
    enc(clamp01(S2PP[3] * lr + S2PP[4] * lg + S2PP[5] * lb)),
    enc(clamp01(S2PP[6] * lr + S2PP[7] * lg + S2PP[8] * lb)),
  ]
  const idx = (v) => Math.min(255, Math.max(0, Math.round(v * 255)))
  const l = [dec(luts.r[idx(p[0])] / 255), dec(luts.g[idx(p[1])] / 255), dec(luts.b[idx(p[2])] / 255)]
  return [
    enc(clamp01(PP2S[0] * l[0] + PP2S[1] * l[1] + PP2S[2] * l[2])),
    enc(clamp01(PP2S[3] * l[0] + PP2S[4] * l[1] + PP2S[5] * l[2])),
    enc(clamp01(PP2S[6] * l[0] + PP2S[7] * l[1] + PP2S[8] * l[2])),
  ]
}

// ---- Shadows / Highlights ---------------------------------------------------------------

export const isLocalActive = (t) => !!(t.shadows || t.highlights)

/** Zone table: [Shadows gain, Highlights gain] (EV) at ZONE_LUT_SIZE zone values over ZONE.range. */
export function buildZoneLUT({ shadows = 0, highlights = 0 }) {
  const lut = new Float32Array(ZONE_LUT_SIZE * 2)
  for (let i = 0; i < ZONE_LUT_SIZE; i++) {
    const x = i / (ZONE_LUT_SIZE - 1)
    lut[i * 2] = sliderOffset(M.local.sliders.shadows, x, shadows)
    lut[i * 2 + 1] = sliderOffset(M.local.sliders.highlights, x, highlights)
  }
  return lut
}

/** Gains [shadows, highlights] for a zone value v (EV, 0 = white, incl. exposure). */
export function sampleZoneLUT(lut, v) {
  const [lo, hi] = ZONE.range
  const p = clamp01((v - lo) / (hi - lo)) * (ZONE_LUT_SIZE - 1)
  const i = Math.min(Math.floor(p), ZONE_LUT_SIZE - 2)
  const t = p - i
  return [lut[i * 2] * (1 - t) + lut[i * 2 + 2] * t, lut[i * 2 + 1] * (1 - t) + lut[i * 2 + 3] * t]
}

// ---- Matrices (Saturation, Calibration) -------------------------------------------------

/** 3×3 row-major matrix for one slider value (identity at 0), from the measurement on the same side. */
function sliderMatrix(slider, value) {
  const entry = (M.matrices[slider] || []).find((e) => e.amount > 0 === value > 0)
  if (!value || !entry) return null
  const t = Math.min(Math.max(value, -100), 100) / entry.amount
  return [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => (r === c ? 1 : 0) + entry.d[r][c] * t))
}

function mul(a, b) {
  const o = new Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return o
}

/**
 * Colour matrix (row-major, linear sRGB) for Saturation and the optional Calibration
 * (`{ redHue, redSaturation, greenHue, greenSaturation, blueHue, blueSaturation }`), or null.
 */
export function colorMatrix(saturation = 0, calibration = null) {
  const values = [
    ['redHue', calibration?.redHue], ['redSaturation', calibration?.redSaturation],
    ['greenHue', calibration?.greenHue], ['greenSaturation', calibration?.greenSaturation],
    ['blueHue', calibration?.blueHue], ['blueSaturation', calibration?.blueSaturation],
    ['saturation', saturation],
  ]
  let m = null
  for (const [slider, value] of values) {
    const s = value ? sliderMatrix(slider, value) : null
    if (s) m = m ? mul(s, m) : s
  }
  return m
}

// ---- Color Mixer (HSL) ------------------------------------------------------------------

let hslData = null
function hslValues() {
  if (!hslData) {
    const bin = atob(M.hsl.encoded)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    hslData = new Float32Array(bytes.buffer)
  }
  return hslData
}

export const HSL_BAND_ORDER = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']

/**
 * Hue × chroma table (RGBA float, HSL_TABLE_WIDTH × HSL_TABLE_ROWS, row r = chroma
 * r/(rows−1)·HSL_MAX_CHROMA, column = hue in degrees): r = hue shift (°), g = ln chroma
 * ratio, b = ln lightness ratio. `bands` = { hue: [8], sat: [8], lum: [8] } in HSL_BAND_ORDER.
 */
export function buildHSLTable(bands) {
  const data = hslValues()
  const bins = M.hsl.hueBins
  const edges = M.hsl.chromaEdges
  const rows = edges.length - 1
  const centres = Array.from({ length: rows }, (_, i) => (edges[i] + edges[i + 1]) / 2)
  const value = (band, side, slider, effect, row, bin) => data[((((band * 2 + side) * 3 + slider) * 3 + effect) * rows + row) * bins + bin]
  const atHue = (band, side, slider, effect, row, hue) => {
    const p = (hue - 2.5) / 5
    const i0 = Math.floor(p)
    const t = p - i0
    const a = ((i0 % bins) + bins) % bins
    const b = (a + 1) % bins
    return value(band, side, slider, effect, row, a) * (1 - t) + value(band, side, slider, effect, row, b) * t
  }
  const sliders = [bands.hue, bands.sat, bands.lum]
  const out = new Float32Array(HSL_TABLE_WIDTH * HSL_TABLE_ROWS * 4)
  for (let r = 0; r < HSL_TABLE_ROWS; r++) {
    const chroma = (HSL_MAX_CHROMA * r) / (HSL_TABLE_ROWS - 1)
    let r0 = 0
    while (r0 < rows - 2 && chroma > centres[r0 + 1]) r0++
    const t = clamp01((chroma - centres[r0]) / (centres[r0 + 1] - centres[r0]))
    for (let col = 0; col < HSL_TABLE_WIDTH; col++) {
      const hue = col % 360
      const e = [0, 0, 0]
      sliders.forEach((values, slider) => {
        values.forEach((v, band) => {
          if (!v) return
          const side = v > 0 ? 1 : 0
          const scale = Math.min(Math.abs(v), 100) / 50
          for (let k = 0; k < 3; k++) {
            e[k] += (atHue(band, side, slider, k, r0, hue) * (1 - t) + atHue(band, side, slider, k, r0 + 1, hue) * t) * scale
          }
        })
      })
      const i = (r * HSL_TABLE_WIDTH + col) * 4
      out[i] = e[0]; out[i + 1] = e[1]; out[i + 2] = e[2]; out[i + 3] = 1
    }
  }
  return out
}

/** Looks up [hue shift °, ln chroma ratio, ln lightness ratio] (bilinear, like the GPU). */
export function sampleHSLTable(table, hueDeg, chroma) {
  const y = clamp01(chroma / HSL_MAX_CHROMA) * (HSL_TABLE_ROWS - 1)
  const y0 = Math.min(Math.floor(y), HSL_TABLE_ROWS - 2), ty = y - y0
  const x0 = Math.min(Math.floor(hueDeg), HSL_TABLE_WIDTH - 2), tx = hueDeg - x0
  const at = (yy, xx, k) => table[(yy * HSL_TABLE_WIDTH + xx) * 4 + k]
  return [0, 1, 2].map((k) =>
    (at(y0, x0, k) * (1 - tx) + at(y0, x0 + 1, k) * tx) * (1 - ty) + (at(y0 + 1, x0, k) * (1 - tx) + at(y0 + 1, x0 + 1, k) * tx) * ty)
}
