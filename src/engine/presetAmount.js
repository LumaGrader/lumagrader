// Preset Amount: blends a photo's settings from before a preset (0 %) to the preset's full
// settings (100 %), and past it up to 200 % (extrapolated, clamped to each slider's range).
// Per-photo things (crop, masks, spot removal) always come from the photo itself.

import { makeCurve, isIdentityCurve, CURVE_KEYS } from './curvePoints'
import { GRADE_WHEELS } from './color'

export const PRESET_AMOUNT_MAX = 200

// Slider ranges, used to clamp extrapolated (> 100 %) values.
const RANGES = {
  exposure: [-5, 5],
  sharpenRadius: [0.5, 3],
  lutStrength: [0, 100],
  vignetteMidpoint: [0, 100], vignetteFeather: [0, 100], vignetteHighlights: [0, 100],
  grain: [0, 100], grainSize: [0, 100], grainRoughness: [0, 100],
  lensVignetteMidpoint: [0, 100],
  sharpen: [0, 100], sharpenDetail: [0, 100], sharpenMasking: [0, 100],
  noiseReduction: [0, 100], denoiseDetail: [0, 100], denoiseContrast: [0, 100],
  colorNoiseReduction: [0, 100], colorNoiseDetail: [0, 100], colorNoiseSmoothness: [0, 100],
}
const DEFAULT_RANGE = [-100, 100]
const PER_PHOTO = new Set(['geometry', 'masks', 'spots', 'engine'])

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, t) => a + (b - a) * t
const round = (v, dp) => { const f = 10 ** dp; return Math.round(v * f) / f }
const decimalsOf = (key) => (key === 'exposure' ? 2 : key === 'sharpenRadius' ? 1 : 0)

function blendNumber(key, a, b, t) {
  if (!Number.isFinite(a)) a = b
  if (!Number.isFinite(b)) return a
  if (a === b) return b
  return round(clamp(lerp(a, b, t), RANGES[key] || DEFAULT_RANGE), decimalsOf(key))
}

/** Blends two point curves by sampling both at every point x of either curve. */
function blendCurve(a, b, t) {
  if (!Array.isArray(a) || a.length < 2) return b
  if (!Array.isArray(b) || b.length < 2) return a
  if (JSON.stringify(a) === JSON.stringify(b)) return b
  if (isIdentityCurve(a) && isIdentityCurve(b)) return b
  const fa = makeCurve(a), fb = makeCurve(b)
  const xs = [...new Set([0, 255, ...a.map((p) => Math.round(p.x)), ...b.map((p) => Math.round(p.x))])].sort((x, y) => x - y)
  return xs.map((x) => ({ x, y: Math.round(Math.min(255, Math.max(0, lerp(fa(x), fb(x), t)))) }))
}

const blendHsl = (a = {}, b = {}, t) => {
  const out = {}
  for (const band of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const pa = a[band] || { h: 0, s: 0, l: 0 }, pb = b[band] || { h: 0, s: 0, l: 0 }
    out[band] = { h: blendNumber('hsl', pa.h, pb.h, t), s: blendNumber('hsl', pa.s, pb.s, t), l: blendNumber('hsl', pa.l, pb.l, t) }
  }
  return out
}

// Colour wheels blend as points on the wheel (hue + saturation together), so fading a
// teal-shadows preset out never sweeps through other hues on the way.
function blendWheel(a = { h: 0, s: 0, l: 0 }, b = { h: 0, s: 0, l: 0 }, t) {
  const rad = Math.PI / 180
  const ax = (a.s || 0) * Math.cos((a.h || 0) * rad), ay = (a.s || 0) * Math.sin((a.h || 0) * rad)
  const bx = (b.s || 0) * Math.cos((b.h || 0) * rad), by = (b.s || 0) * Math.sin((b.h || 0) * rad)
  const x = lerp(ax, bx, t), y = lerp(ay, by, t)
  const s = Math.min(100, Math.hypot(x, y))
  let h = s > 0.05 ? Math.atan2(y, x) / rad : (b.s ? b.h : a.h) || 0
  if (h < 0) h += 360
  return { h: Math.round(h) % 360, s: Math.round(s), l: blendNumber('gradeLum', a.l, b.l, t) }
}

function blendGrade(a, b, t) {
  if (!a) return b
  if (!b) return a
  const out = { ...b }
  for (const w of GRADE_WHEELS) out[w] = blendWheel(a[w], b[w], t)
  out.blending = blendNumber('gradeBlending', a.blending ?? 50, b.blending ?? 50, t)
  out.blending = Math.min(100, Math.max(0, out.blending))
  out.balance = blendNumber('gradeBalance', a.balance ?? 0, b.balance ?? 0, t)
  return out
}

function blendCalibration(a, b, t) {
  if (!a && !b) return b ?? a ?? null
  const out = {}
  for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const v = blendNumber('calibration', a?.[key] ?? 0, b?.[key] ?? 0, t)
    if (v) out[key] = v
  }
  return Object.keys(out).length ? out : null
}

/** RAW white balance: null means As Shot. Kelvin blends in mired (perceptually even). */
function blendWB(a, b, t, asShot) {
  if (!asShot) return b ?? null
  const A = a || asShot, B = b || asShot
  if (A.kelvin === B.kelvin && A.tint === B.tint) return b ?? null
  const mired = lerp(1e6 / A.kelvin, 1e6 / B.kelvin, t)
  const kelvin = Math.round(Math.min(50000, Math.max(2000, 1e6 / Math.max(20, mired))))
  const tint = Math.round(Math.min(150, Math.max(-150, lerp(A.tint, B.tint, t))))
  if (Math.abs(kelvin - asShot.kelvin) < 1 && Math.abs(tint - asShot.tint) < 0.5) return null
  return { kelvin, tint }
}

/**
 * Settings at `t` (0 = `before`, 1 = `full`, up to 2) between a photo's pre-preset settings
 * and the preset result. `asShot` = the photo's as-shot white balance (RAW) or null.
 */
export function blendPresetSettings(before, full, t, asShot = null) {
  if (t >= 0.9995 && t <= 1.0005) return full
  const out = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(full)])) {
    const a = before[key], b = full[key]
    if (PER_PHOTO.has(key)) out[key] = key === 'engine' ? (b ?? a) : a
    else if (key === 'wb') out.wb = blendWB(a, b, t, asShot)
    else if (key === 'hsl') out.hsl = blendHsl(a, b, t)
    else if (key === 'colorGrade') out.colorGrade = blendGrade(a, b, t)
    else if (key === 'calibration') out.calibration = blendCalibration(a, b, t)
    else if (CURVE_KEYS.includes(key)) out[key] = blendCurve(a, b, t)
    else if (typeof b === 'number' || typeof a === 'number') out[key] = blendNumber(key, Number(a), Number(b), t)
    // Profile, LUT, on/off switches: the preset's choice as soon as any of it is applied.
    else out[key] = t > 0 ? (b === undefined ? a : b) : (a === undefined ? b : a)
  }
  // A LUT the photo didn't have fades in through its strength rather than popping in.
  if (full.lut && full.lut !== before.lut && t > 0) {
    out.lutStrength = round(clamp((full.lutStrength ?? 100) * t, [0, 100]), 0)
  }
  return out
}

/** Order-insensitive deep equality for settings objects. */
export function sameSettings(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined)
  if (ka.length !== kb.length) return false
  return ka.every((k) => sameSettings(a[k], b[k]))
}
