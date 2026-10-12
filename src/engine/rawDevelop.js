// RAW "develop": turns LibRaw's linear 16-bit RGB (camera white balance, sRGB primaries) into
// the 8-bit sRGB image the editor starts from.
//
// Goal: look like the camera's own rendering at first (the embedded JPEG is used only as a
// TARGET for brightness/contrast/saturation statistics), but with pixels from real sensor data:
// no JPEG blocks, no in-camera over-sharpening, and extra highlight detail (a soft shoulder
// keeps gradation the camera JPEG clipped). Like Lightroom's default, colour noise is reduced
// (chroma smoothing); luminance noise is left alone (use Detail → Noise Reduction).
//
// Pure functions on typed arrays — runs inside workers/developWorker.js.

import { applyLumaColorLook } from './rawLook'

const W_R = 0.2126, W_G = 0.7152, W_B = 0.0722
const LOG_FLOOR = -17
const QUANTILES = Array.from({ length: 120 }, (_, i) => 0.2 + (i * (99.8 - 0.2)) / 119)

const srgbEncode = (y) => (y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055)
const srgbDecode = (p) => (p <= 0.04045 ? p / 12.92 : Math.pow((p + 0.055) / 1.055, 2.4))

function percentiles(values, qs) {
  const s = Float32Array.from(values).sort()
  return qs.map((q) => s[Math.min(s.length - 1, Math.max(0, Math.round((q / 100) * (s.length - 1))))])
}

/** Encoded-space saturation (max−min)/max of an sRGB-encoded pixel. */
const satOf = (r, g, b) => {
  const mx = Math.max(r, g, b)
  return mx > 1e-3 ? (mx - Math.min(r, g, b)) / mx : 0
}

/**
 * Target statistics from the camera's embedded JPEG (RGBA bytes, any size — a ~800px copy is
 * plenty): linear-luminance quantiles and mean saturation.
 */
export function targetStatsFromRGBA(rgba) {
  const Y = []
  let sat = 0, n = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] / 255, g = rgba[i + 1] / 255, b = rgba[i + 2] / 255
    Y.push(W_R * srgbDecode(r) + W_G * srgbDecode(g) + W_B * srgbDecode(b))
    sat += satOf(r, g, b)
    n++
  }
  return { quantiles: percentiles(Y, QUANTILES), saturation: sat / n }
}

/** Sampled linear-luminance quantiles of the RAW data (Uint16 RGB, 0..65535). */
function rawQuantiles(data16, w, h) {
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)))
  const Y = []
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * 3
    Y.push((W_R * data16[i] + W_G * data16[i + 1] + W_B * data16[i + 2]) / 65535)
  }
  return percentiles(Y, QUANTILES)
}

/**
 * Monotone tone curve in log-log space from RAW quantiles → target quantiles, with a soft
 * shoulder above the brightest matched point (keeps highlight gradation instead of clipping).
 * Returned params are plain numbers/arrays → stored with the photo so the full-size export
 * develops identically without needing the JPEG again.
 */
export function buildDevelopParams(data16, w, h, target) {
  const qr = rawQuantiles(data16, w, h).map((v) => Math.log2(Math.max(v, 2 ** LOG_FLOOR)))
  let qj
  if (target?.quantiles) qj = target.quantiles.map((v) => Math.log2(Math.max(v, 2 ** LOG_FLOOR)))
  else {
    // No camera JPEG: expose so the median lands at ~11% linear (a typical camera rendering).
    const shift = Math.log2(0.11) - qr[Math.floor(qr.length / 2)]
    qj = qr.map((v) => Math.min(-0.05, v + shift))
  }
  // Smooth (moving average) and force strictly increasing.
  const smooth = (arr) => arr.map((_, i) => {
    let a = 0, c = 0
    for (let k = -2; k <= 2; k++) { const j = Math.min(arr.length - 1, Math.max(0, i + k)); a += arr[j]; c++ }
    return a / c
  })
  const xs = smooth(qr), ys = smooth(qj)
  for (let i = 1; i < xs.length; i++) {
    xs[i] = Math.max(xs[i], xs[i - 1] + 1e-3)
    ys[i] = Math.max(ys[i], ys[i - 1] + 1e-3)
  }
  const n = xs.length
  const slopeTop = Math.max(0.3, Math.min(2.5, (ys[n - 1] - ys[n - 6]) / (xs[n - 1] - xs[n - 6])))
  const headroom = Math.max(0.05, -ys[n - 1]) // stops left below white at the top matched point
  return { xs, ys, slopeTop, headroom, saturation: 1, targetSaturation: target?.saturation ?? null }
}

/** Output linear luminance for RAW linear luminance y (0..1) under develop params. */
export function developCurve(y, p) {
  const L = Math.log2(Math.max(y, 2 ** LOG_FLOOR))
  const { xs, ys } = p
  const n = xs.length
  let out
  if (L <= xs[0]) out = ys[0] + (L - xs[0])
  else if (L >= xs[n - 1]) {
    const e = (L - xs[n - 1]) * p.slopeTop
    out = ys[n - 1] + p.headroom * (1 - Math.exp(-e / p.headroom))
  } else {
    let lo = 0, hi = n - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= L) lo = m; else hi = m }
    const t = (L - xs[lo]) / (xs[hi] - xs[lo])
    out = ys[lo] + t * (ys[hi] - ys[lo])
  }
  return Math.pow(2, out)
}

function buildRatioLUT(p) {
  // Indexed by 16-bit luminance; value = output ÷ input luminance.
  const lut = new Float32Array(65536)
  for (let i = 0; i < 65536; i++) {
    const y = Math.max(i, 0.5) / 65535
    lut[i] = developCurve(y, p) / y
  }
  return lut
}

const ENCODE = Uint8ClampedArray.from({ length: 16384 }, (_, i) => Math.round(srgbEncode(i / 16383) * 255))
const enc8 = (v) => ENCODE[v <= 0 ? 0 : v >= 1 ? 16383 : (v * 16383 + 0.5) | 0]

function toneAndColor(data16, w, h, p, lut, sat, out) {
  for (let i = 0, o = 0; o < w * h * 4; i += 3, o += 4) {
    const r0 = data16[i], g0 = data16[i + 1], b0 = data16[i + 2]
    const yi = (W_R * r0 + W_G * g0 + W_B * b0 + 0.5) | 0
    const k = lut[yi > 65535 ? 65535 : yi] / 65535
    let r = r0 * k, g = g0 * k, b = b0 * k
    const Y = W_R * r + W_G * g + W_B * b
    if (sat !== 1) { r = Y + (r - Y) * sat; g = Y + (g - Y) * sat; b = Y + (b - Y) * sat }
    const m = Math.max(r, g, b)
    if (m > 1) {
      // Gamut fit: desaturate toward luminance instead of clipping channels (keeps hue).
      if (Y >= 1) { r = g = b = 1 } else { const t = (1 - Y) / (m - Y); r = Y + (r - Y) * t; g = Y + (g - Y) * t; b = Y + (b - Y) * t }
    }
    out[o] = enc8(r); out[o + 1] = enc8(g); out[o + 2] = enc8(b); out[o + 3] = 255
  }
}

/**
 * Toned (not yet saturated) linear RGB samples for the saturation fit, each the average of a
 * small block. The target is measured on the camera JPEG scaled to ~800 px (in-camera noise
 * reduction + downscale), so the RAW is measured at the same scale: block-averaging removes
 * colour noise that would otherwise read as "colour" (at high ISO the fit then made the photo
 * duller, and colour NR afterwards removed the rest).
 */
const SAT_FIT_SCALE = 800
function saturationSamples(data16, w, h, lut) {
  const block = Math.max(1, Math.round(Math.max(w, h) / SAT_FIT_SCALE))
  const step = Math.max(block, Math.floor(Math.sqrt((w * h) / 40000)))
  const out = []
  for (let y0 = 0; y0 + block <= h; y0 += step) for (let x0 = 0; x0 + block <= w; x0 += step) {
    let r = 0, g = 0, b = 0
    for (let y = y0; y < y0 + block; y++) for (let x = x0; x < x0 + block; x++) {
      const i = (y * w + x) * 3
      const r0 = data16[i], g0 = data16[i + 1], b0 = data16[i + 2]
      const yi = Math.min(65535, (W_R * r0 + W_G * g0 + W_B * b0 + 0.5) | 0)
      const k = lut[yi] / 65535
      r += r0 * k; g += g0 * k; b += b0 * k
    }
    const nb = block * block
    out.push(r / nb, g / nb, b / nb)
  }
  return out
}

/** Mean encoded saturation of the samples with saturation factor s (same maths as toneAndColor). */
function sampledSaturation(samples, s) {
  let acc = 0
  for (let i = 0; i < samples.length; i += 3) {
    let r = samples[i], g = samples[i + 1], b = samples[i + 2]
    const Y = W_R * r + W_G * g + W_B * b
    r = Y + (r - Y) * s; g = Y + (g - Y) * s; b = Y + (b - Y) * s
    const m = Math.max(r, g, b)
    if (m > 1) {
      if (Y >= 1) { r = g = b = 1 } else { const t = (1 - Y) / (m - Y); r = Y + (r - Y) * t; g = Y + (g - Y) * t; b = Y + (b - Y) * t }
    }
    acc += satOf(srgbEncode(Math.max(0, r)), srgbEncode(Math.max(0, g)), srgbEncode(Math.max(0, b)))
  }
  return acc / Math.max(1, samples.length / 3)
}

/**
 * Colour-noise reduction on the 8-bit result: smooths chroma (Cb/Cr) with a small box blur
 * while keeping luma untouched — similar in spirit to Lightroom's default Color NR.
 * Memory-lean for full-size exports (26 MP): chroma is kept as Int16 (×16 fixed point) and
 * blurred in place with one shared temp row buffer set, so the peak extra memory is ~3×2 B/px.
 */
const FX = 16
const rnd = (v) => v + (v >= 0 ? 0.5 : -0.5) // Int16Array store truncates → round half away from 0
function reduceColorNoise(rgba, w, h, radius) {
  const n = w * h
  const Cb = new Int16Array(n), Cr = new Int16Array(n)
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2]
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    Cb[i] = Math.round((b - y) * FX); Cr[i] = Math.round((r - y) * FX)
  }
  const tmp = new Int16Array(n), d = 2 * radius + 1
  const blurInPlace = (src) => {
    for (let y = 0; y < h; y++) {
      const row = y * w
      let acc = 0
      for (let x = -radius; x <= radius; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]
      for (let x = 0; x < w; x++) { tmp[row + x] = rnd(acc / d); acc += src[row + Math.min(w - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)] }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]
      for (let y = 0; y < h; y++) { src[y * w + x] = rnd(acc / d); acc += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x] }
    }
  }
  blurInPlace(Cb); blurInPlace(Cb) // two box passes ≈ Gaussian
  blurInPlace(Cr); blurInPlace(Cr)
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const y = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]
    const r = y + Cr[i] / FX, b = y + Cb[i] / FX
    const g = (y - 0.299 * r - 0.114 * b) / 0.587
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b // Uint8ClampedArray clamps + rounds
  }
}

/**
 * Develops LibRaw output. `params` from buildDevelopParams (reuse them for the full-size export
 * so both match). Returns { rgba: Uint8ClampedArray, params } (params gain the fitted saturation).
 */
export function developRaw(data16, w, h, params) {
  const p = { ...params }
  const lut = buildRatioLUT(p)
  if (p.targetSaturation != null && p.saturation === 1 && !p.saturationFitted) {
    // Match the camera's colourfulness (bisection on a pixel sample), within sane bounds.
    const samples = saturationSamples(data16, w, h, lut)
    let lo = 0.8, hi = 1.6
    for (let it = 0; it < 14; it++) {
      const mid = (lo + hi) / 2
      if (sampledSaturation(samples, mid) < p.targetSaturation) lo = mid
      else hi = mid
    }
    p.saturation = Math.round(((lo + hi) / 2) * 1000) / 1000
    p.saturationFitted = true
  }
  const rgba = new Uint8ClampedArray(w * h * 4)
  toneAndColor(data16, w, h, p, lut, p.saturation, rgba)
  // Radius scales with resolution so preview (half size) and export (full size) match.
  reduceColorNoise(rgba, w, h, Math.max(1, Math.round(Math.max(w, h) / 1600)))
  // "Luma Color" base look (Lightroom-like default colour) on top of the camera match.
  if (p.look !== 'camera') applyLumaColorLook(rgba)
  return { rgba, params: p }
}
