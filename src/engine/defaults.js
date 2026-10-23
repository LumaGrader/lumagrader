import { HSL_BANDS } from './hsl'
import { defaultCurvePoints } from './curvePoints'
import { defaultGeometry } from './geometry'
import { canonicalProfile } from './colorProfiles'
import { defaultColorGrade, hueSat } from './color'

// Exposure is in stops (EV); vignette follows Lightroom (negative = darker corners).
export const PRESETS = {
  None: { exposure: 0, contrast: 0, curve: 0, saturation: 0, temp: 0, tint: 0, vignette: 0, grain: 0 },
  'Travel Warm': { exposure: 0.08, contrast: 14, curve: 10, saturation: 12, temp: 22, tint: -4, vignette: -18, grain: 6 },
  'Moody Grade': { exposure: -0.12, contrast: 22, curve: 20, saturation: -18, temp: -8, tint: 8, vignette: -30, grain: 12 },
  'Clean Vlog': { exposure: 0.11, contrast: 8, curve: 5, saturation: 6, temp: 4, tint: 0, vignette: 0, grain: 0 },
  'B&W Film': { exposure: 0, contrast: 18, curve: 15, saturation: -100, temp: 0, tint: 0, vignette: -22, grain: 16 },
  'Golden Hour': { exposure: 0.14, contrast: 10, curve: 8, saturation: 16, temp: 32, tint: -10, vignette: -14, grain: 4 },
}

/**
 * Engine version of a settings object. v1 (no marker): Exposure was a ±100 brightness
 * multiplier. v2: Exposure is in stops (EV, ±5) and the tone sliders behave like Lightroom.
 * v3: Lightroom-like color (white balance, vibrance/saturation, HSL); bipolar presence
 * sliders; Lightroom vignette sign. v4: Lightroom-style Color Grading (3 wheels + Global).
 */
export const ENGINE_VERSION = 4

/**
 * Upgrades settings saved by an older engine (projects, presets, preset files).
 *  v1 → v2: Exposure ±100 brightness multiplier → stops (EV).
 *  v2 → v3: Vignette sign flipped to Lightroom's convention (negative = darker corners).
 *           Temp/Tint, Vibrance/Saturation and HSL keep their numbers but now use the
 *           Lightroom-like color engine (color.js), so old edits look slightly different.
 */
export function migrateSettings(s) {
  if (!s || typeof s !== 'object') return s
  // Legacy "Adobe …" profile names → "Luma …" (independent of the engine version).
  if (s.colorProfile && s.colorProfile !== canonicalProfile(s.colorProfile)) s = { ...s, colorProfile: canonicalProfile(s.colorProfile) }
  if (s.engine >= ENGINE_VERSION) return s
  const out = { ...s, engine: ENGINE_VERSION }
  const from = Number(s.engine) || 1
  if (from < 2) {
    // v1 exposure n meant brightness × (1 + n/100) → the same brightness in stops.
    const factor = Math.max(1 / 32, 1 + (Number(s.exposure) || 0) / 100)
    out.exposure = Math.round(Math.min(5, Math.max(-5, Math.log2(factor))) * 100) / 100
  }
  if (from < 3 && out.vignette) out.vignette = -Math.abs(Number(out.vignette) || 0)
  if (from < 4) out.colorGrade = migrateColorGrade(s.colorGrade)
  return out
}

/**
 * v3 → v4: the single-colour grade { hex, intensity } becomes the Global wheel of the
 * Lightroom-style Color Grading (hue of the colour, saturation ≈ intensity × its saturation).
 */
function migrateColorGrade(cg) {
  if (!cg || typeof cg !== 'object') return defaultColorGrade()
  if (cg.global || cg.midtones) return { ...defaultColorGrade(), ...cg }
  const out = defaultColorGrade()
  const n = parseInt(String(cg.hex || '#000000').slice(1), 16)
  const [h, sat] = hueSat(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
  const intensity = Math.max(0, Math.min(100, Number(cg.intensity) || 0))
  if (intensity > 0 && sat > 0) out.global = { h: Math.round(h), s: Math.round(intensity * sat), l: 0 }
  return out
}

export const defaultHsl = () => Object.fromEntries(HSL_BANDS.map((b) => [b, { h: 0, s: 0, l: 0 }]))

export const defaultSettings = () => ({
  engine: ENGINE_VERSION,
  colorProfile: 'Luma Color',
  ...PRESETS.None,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  vignetteMidpoint: 50,
  vignetteRoundness: 0,
  vignetteFeather: 50,
  vignetteHighlights: 0,
  grainSize: 25,
  grainRoughness: 50,
  wb: null, // RAW only: { kelvin, tint } absolute white balance; null = As Shot
  curvePoints: defaultCurvePoints(),
  curvePointsR: defaultCurvePoints(),
  curvePointsG: defaultCurvePoints(),
  curvePointsB: defaultCurvePoints(),
  geometry: defaultGeometry(),
  masks: [],
  spots: [], // spot removal — see heal.js
  lensDistortion: 0,
  lensVignette: 0,
  lensVignetteMidpoint: 50,
  removeCA: false,
  sharpen: 0,
  sharpenRadius: 1.0,
  sharpenDetail: 25,
  sharpenMasking: 0,
  noiseReduction: 0, // Luminance noise reduction amount
  denoiseDetail: 50,
  denoiseContrast: 0,
  colorNoiseReduction: 0,
  colorNoiseDetail: 50,
  colorNoiseSmoothness: 50,
  clarity: 0,
  texture: 0,
  dehaze: 0,
  lut: null,
  lutStrength: 100,
  hsl: defaultHsl(),
  colorGrade: defaultColorGrade(),
  // Lightroom Calibration from imported presets (no panel yet): { redHue, redSaturation,
  // greenHue, greenSaturation, blueHue, blueSaturation } or null — see lrModel.colorMatrix.
  calibration: null,
})
