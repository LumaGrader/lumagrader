// Lightroom / Camera Raw preset import: .xmp, .lrtemplate (Lightroom Classic ≤ 7) and the
// XMP packet inside a .dng (how Lightroom Mobile presets are shared).
//
// All formats carry the same Camera Raw setting names (Exposure2012, Clarity2012, …). Each
// format has a small "reader" (raw / num / list / lookName / hasEntries / title) and one
// shared mapping, presetFromReader(), translates them to the closest LumaGrader sliders. The
// two apps use different math, so a preset follows Lightroom's *direction*, not its pixels.
//
// Preset files come from the internet: XMP goes through DOMParser (never fetches external
// entities), .lrtemplate through a small Lua-table parser here (nothing is executed), and
// every number is validated and clamped.

import { defaultSettings } from './defaults'
import { defaultGeometry } from './geometry'
import { HSL_BANDS } from './hsl'
import { COLOR_PROFILE_NAMES } from './colorProfiles'
import { defaultColorGrade } from './color'

const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
export const MAX_XMP_BYTES = 2 * 1024 * 1024

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const LR_BAND = { red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', aqua: 'Aqua', blue: 'Blue', purple: 'Purple', magenta: 'Magenta' }

/** The rdf:Description holding the preset's settings (not the one nested in crs:Look). */
function findSettingsNode(doc) {
  const descriptions = Array.from(doc.getElementsByTagNameNS(RDF, 'Description'))
  const outside = descriptions.filter((d) => {
    for (let p = d.parentElement; p; p = p.parentElement) if (p.namespaceURI === CRS) return false
    return true
  })
  return outside.find((d) => Array.from(d.attributes).some((a) => a.namespaceURI === CRS) || Array.from(d.children).some((c) => c.namespaceURI === CRS)) || null
}

const toNum = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(/^\+/, ''))
  return Number.isFinite(n) ? n : null
}

function makeXmpReader(node) {
  const direct = (name) => Array.from(node.children).find((c) => c.namespaceURI === CRS && c.localName === name) || null
  const raw = (name) => {
    if (node.hasAttributeNS(CRS, name)) return node.getAttributeNS(CRS, name)
    const el = direct(name)
    return el && el.children.length === 0 ? el.textContent.trim() : null
  }
  return {
    raw,
    num: (name) => toNum(raw(name)),
    list: (name) => listItems(direct(name)), // rdf:Seq/Alt items ("x, y" for curves)
    hasEntries: (name) => {
      const el = direct(name)
      const v = raw(name)
      return !!((el && el.getElementsByTagNameNS(RDF, 'li').length) || (v && v !== '0' && v !== 'False'))
    },
    lookName: () => {
      const lookEl = direct('Look')
      if (!lookEl) return raw('CameraProfile')
      const d = lookEl.getElementsByTagNameNS(RDF, 'Description')[0]
      return d?.getAttributeNS(CRS, 'Name') || listItems(d?.getElementsByTagNameNS(CRS, 'Name')[0])[0] || null
    },
    title: () => listItems(direct('Name'))[0] || raw('Name') || null,
  }
}

/** Text of an rdf:Alt / rdf:Seq entry list under a crs element. */
function listItems(el) {
  return el ? Array.from(el.getElementsByTagNameNS(RDF, 'li')).map((li) => li.textContent.trim()) : []
}

/**
 * Parses one .xmp preset. Returns { name, settings, applied, partial, skipped } or throws
 * with a user-readable message.
 */
export function parseXmpPreset(text, fileName = 'Preset.xmp') {
  if (/^\s*s\s*=\s*\{/.test(text)) return parseLrTemplate(text, fileName)
  const doc = new window.DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Not a valid XMP file.')
  const node = findSettingsNode(doc)
  if (!node) throw new Error('No Lightroom/Camera Raw settings found in this file.')
  return presetFromReader(makeXmpReader(node), fileName)
}

/**
 * The shared mapping from Camera Raw setting names to LumaGrader settings.
 * `r` = { raw(name), num(name), list(name), hasEntries(name), lookName(), title() }.
 */
function presetFromReader(r, fileName) {
  const s = defaultSettings()
  s.geometry = defaultGeometry()
  s.masks = []
  const applied = []
  const partial = []
  const skipped = []

  const set = (key, value, label) => {
    if (value === null || value === undefined) return
    s[key] = Math.round(value)
    applied.push(label)
  }
  const direct = (lrName, key, label, lo = -100, hi = 100, fallbackName) => {
    const v = r.num(lrName) ?? (fallbackName ? r.num(fallbackName) : null)
    if (v === null) return
    if (v < lo || v > hi) partial.push(`${label} (clamped)`)
    set(key, clamp(v, lo, hi), label)
  }

  // --- Light ---------------------------------------------------------------------------
  const ev = r.num('Exposure2012') ?? r.num('Exposure')
  if (ev !== null) {
    // Both apps use stops (EV, ±5) — a direct 1:1 mapping.
    s.exposure = Math.round(clamp(ev, -5, 5) * 100) / 100
    applied.push('Exposure')
  }
  direct('Contrast2012', 'contrast', 'Contrast', -100, 100)
  direct('Highlights2012', 'highlights', 'Highlights')
  direct('Shadows2012', 'shadows', 'Shadows')
  direct('Whites2012', 'whites', 'Whites')
  direct('Blacks2012', 'blacks', 'Blacks')

  // --- Presence ------------------------------------------------------------------------
  for (const [lr, key, label] of [['Texture', 'texture', 'Texture'], ['Clarity2012', 'clarity', 'Clarity'], ['Dehaze', 'dehaze', 'Dehaze']]) {
    const v = r.num(lr) ?? (lr === 'Clarity2012' ? r.num('Clarity') : null)
    if (v === null) continue
    set(key, clamp(v, -100, 100), label)
  }
  direct('Vibrance', 'vibrance', 'Vibrance')
  direct('Saturation', 'saturation', 'Saturation')

  // --- Calibration (no panel; applied with the measured Lightroom matrices) --------------
  const calibration = {}
  for (const [lr, key] of [['RedHue', 'redHue'], ['RedSaturation', 'redSaturation'], ['GreenHue', 'greenHue'],
    ['GreenSaturation', 'greenSaturation'], ['BlueHue', 'blueHue'], ['BlueSaturation', 'blueSaturation']]) {
    const v = r.num(lr)
    if (v) calibration[key] = Math.round(clamp(v, -100, 100))
  }
  if (Object.keys(calibration).length) {
    s.calibration = calibration
    applied.push('Calibration')
  }

  // --- White balance -------------------------------------------------------------------
  const incTemp = r.num('IncrementalTemperature')
  const incTint = r.num('IncrementalTint')
  if (incTemp !== null) set('temp', clamp(incTemp, -100, 100), 'Temperature')
  if (incTint !== null) set('tint', clamp(incTint, -100, 100), 'Tint')
  // RAW presets carry absolute Kelvin/Tint (WhiteBalance = Custom, Daylight, …). They apply
  // to RAW photos (Kelvin white balance); JPEGs ignore them, as in Lightroom.
  const kelvin = r.num('Temperature')
  if (incTemp === null && kelvin !== null && r.raw('WhiteBalance') !== 'As Shot') {
    s.wb = { kelvin: Math.round(clamp(kelvin, 2000, 50000)), tint: Math.round(clamp(r.num('Tint') ?? 0, -150, 150)) }
    applied.push('White balance (Kelvin — RAW photos)')
  }

  // --- HSL (same 8 bands as Lightroom) -------------------------------------------------
  let hslCount = 0
  for (const band of HSL_BANDS) {
    const b = LR_BAND[band]
    const h = r.num(`HueAdjustment${b}`), sat = r.num(`SaturationAdjustment${b}`), lum = r.num(`LuminanceAdjustment${b}`)
    if (h !== null) { s.hsl[band].h = Math.round(clamp(h, -100, 100)); hslCount++ }
    if (sat !== null) { s.hsl[band].s = Math.round(clamp(sat, -100, 100)); hslCount++ }
    if (lum !== null) { s.hsl[band].l = Math.round(clamp(lum, -100, 100)); hslCount++ }
  }
  if (hslCount) applied.push('HSL')

  // --- Detail --------------------------------------------------------------------------
  const sharp = r.num('Sharpness')
  if (sharp !== null) set('sharpen', clamp((sharp / 150) * 100, 0, 100), 'Sharpening')
  const radius = r.num('SharpenRadius')
  if (radius !== null) { s.sharpenRadius = Math.round(clamp(radius, 0.5, 3) * 10) / 10; applied.push('Sharpen radius') }
  direct('SharpenDetail', 'sharpenDetail', 'Sharpen detail', 0, 100)
  direct('SharpenEdgeMasking', 'sharpenMasking', 'Sharpen masking', 0, 100)
  direct('LuminanceSmoothing', 'noiseReduction', 'Noise reduction', 0, 100)
  direct('LuminanceNoiseReductionDetail', 'denoiseDetail', 'NR detail', 0, 100)
  direct('LuminanceNoiseReductionContrast', 'denoiseContrast', 'NR contrast', 0, 100)
  direct('ColorNoiseReduction', 'colorNoiseReduction', 'Color NR', 0, 100)
  direct('ColorNoiseReductionDetail', 'colorNoiseDetail', 'Color NR detail', 0, 100)
  direct('ColorNoiseReductionSmoothness', 'colorNoiseSmoothness', 'Color NR smoothness', 0, 100)

  // --- Effects -------------------------------------------------------------------------
  const vig = r.num('PostCropVignetteAmount')
  if (vig !== null) {
    set('vignette', clamp(vig, -100, 100), 'Vignette') // same sign convention as Lightroom
  }
  direct('PostCropVignetteMidpoint', 'vignetteMidpoint', 'Vignette midpoint', 0, 100)
  direct('PostCropVignetteRoundness', 'vignetteRoundness', 'Vignette roundness', -100, 100)
  direct('PostCropVignetteFeather', 'vignetteFeather', 'Vignette feather', 0, 100)
  direct('PostCropVignetteHighlightContrast', 'vignetteHighlights', 'Vignette highlights', 0, 100)
  direct('GrainAmount', 'grain', 'Grain', 0, 100)
  direct('GrainSize', 'grainSize', 'Grain size', 0, 100)
  direct('GrainFrequency', 'grainRoughness', 'Grain roughness', 0, 100)

  // --- Tone curve ----------------------------------------------------------------------
  // RGB composite + per-channel (Red/Green/Blue) point curves, same 0–255 scale as ours.
  const readCurve = (name) => {
    const pts = r.list(name)
      .map((p) => p.split(',').map((n) => Number(n.trim())))
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      .map(([x, y]) => ({ x: Math.round(clamp(x, 0, 255)), y: Math.round(clamp(y, 0, 255)) }))
    return pts.filter((p, i, arr) => arr.findIndex((q) => q.x === p.x) === i).sort((a, b) => a.x - b.x)
  }
  const curveTargets = [
    ['ToneCurvePV2012', 'curvePoints', 'Tone curve'],
    ['ToneCurvePV2012Red', 'curvePointsR', 'Tone curve (Red)'],
    ['ToneCurvePV2012Green', 'curvePointsG', 'Tone curve (Green)'],
    ['ToneCurvePV2012Blue', 'curvePointsB', 'Tone curve (Blue)'],
  ]
  for (const [xmpName, key, label] of curveTargets) {
    const pts = readCurve(xmpName)
    if (pts.length >= 2 && pts.length <= 32 && pts.some((p) => p.x !== p.y)) {
      s[key] = pts
      applied.push(label)
    }
  }

  // --- Color grading (3 wheels + Global, Blending, Balance) — 1:1 with Lightroom ---------
  // Older presets use Split Toning (shadow/highlight hue + saturation, balance).
  const wheel = (key, lrName, splitHue, splitSat) => {
    const h = r.num(`ColorGrade${lrName}Hue`) ?? (splitHue ? r.num(splitHue) : null)
    const sat = r.num(`ColorGrade${lrName}Sat`) ?? (splitSat ? r.num(splitSat) : null)
    const lum = r.num(`ColorGrade${lrName}Lum`)
    if (h === null && sat === null && lum === null) return false
    s.colorGrade[key] = { h: Math.round(clamp(h ?? 0, 0, 360)), s: Math.round(clamp(sat ?? 0, 0, 100)), l: Math.round(clamp(lum ?? 0, -100, 100)) }
    return !!(sat || lum)
  }
  s.colorGrade = defaultColorGrade()
  let gradeUsed = false
  gradeUsed = wheel('shadows', 'Shadow', 'SplitToningShadowHue', 'SplitToningShadowSaturation') || gradeUsed
  gradeUsed = wheel('midtones', 'Midtone') || gradeUsed
  gradeUsed = wheel('highlights', 'Highlight', 'SplitToningHighlightHue', 'SplitToningHighlightSaturation') || gradeUsed
  gradeUsed = wheel('global', 'Global') || gradeUsed
  const blend = r.num('ColorGradeBlending')
  if (blend !== null) s.colorGrade.blending = Math.round(clamp(blend, 0, 100))
  const bal = r.num('SplitToningBalance') ?? r.num('ColorGradeBalance')
  if (bal !== null) s.colorGrade.balance = Math.round(clamp(bal, -100, 100))
  if (gradeUsed) applied.push('Color grading')

  // --- Profile -------------------------------------------------------------------------
  const lookName = r.lookName()
  if (lookName) {
    const wanted = String(lookName).toLowerCase().replace(/^adobe /, 'luma ') // LR "Adobe Color" → our "Luma Color"
    const match = COLOR_PROFILE_NAMES.find((n) => n.toLowerCase() === wanted)
    if (match) { s.colorProfile = match; applied.push('Profile') }
    else skipped.push(`Profile "${lookName}"`)
  }
  if (r.raw('ConvertToGrayscale') === 'True') {
    s.colorProfile = 'Luma Monochrome'
    if (!applied.includes('Profile')) applied.push('Black & white')
  }

  // --- Lens corrections (manual) -------------------------------------------------------
  direct('LensManualDistortionAmount', 'lensDistortion', 'Lens distortion', -100, 100)
  direct('VignetteAmount', 'lensVignette', 'Lens vignetting', -100, 100)
  direct('VignetteMidpoint', 'lensVignetteMidpoint', 'Lens vignetting midpoint', 0, 100)
  const autoCA = r.raw('AutoLateralCA')
  if (autoCA === '1' || autoCA === 'True') { s.removeCA = true; applied.push('Remove chromatic aberration') }

  // --- Not supported -------------------------------------------------------------------
  const unsupported = [
    ['MaskGroupBasedCorrections', 'Masks'], ['GradientBasedCorrections', 'Graduated filters'],
    ['CircularGradientBasedCorrections', 'Radial filters'], ['PaintBasedCorrections', 'Brush adjustments'],
    ['RetouchInfo', 'Spot removal'], ['LensProfileEnable', 'Lens profile (use the manual lens sliders)'],
  ]
  for (const [lr, label] of unsupported) {
    if (r.hasEntries(lr)) skipped.push(label)
  }

  const nameFromFile = String(fileName).replace(/^.*[\\/]/, '').replace(/\.(xmp|lrtemplate|dng)$/i, '').trim()
  const name = (r.title() || nameFromFile || 'Imported preset').split('').filter((ch) => ch.charCodeAt(0) >= 32).join('').trim().slice(0, 80) || 'Imported preset'

  if (!applied.length) throw new Error('No supported settings found in this preset.')
  return { name, settings: s, applied, partial, skipped }
}

// ---- .lrtemplate (Lightroom Classic ≤ 7) ---------------------------------------------
// A Lua table: s = { title = "…", value = { settings = { Exposure2012 = 0.5, … } } }.
// Parsed by a tiny tokenizer + recursive reader — only literals are understood; nothing runs.

const MAX_LUA_DEPTH = 32
const MAX_LUA_TOKENS = 500000

function tokenizeLua(src) {
  const tokens = []
  let i = 0
  const n = src.length
  while (i < n) {
    if (tokens.length > MAX_LUA_TOKENS) throw new Error('Preset file is too complex.')
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿') { i++; continue }
    if (c === '-' && src[i + 1] === '-') { // comment (line or --[[ block ]])
      const long = src.slice(i + 2).match(/^\[(=*)\[/)
      if (long) { const end = src.indexOf(']' + long[1] + ']', i); i = end < 0 ? n : end + long[1].length + 2 }
      else { const end = src.indexOf('\n', i); i = end < 0 ? n : end + 1 }
      continue
    }
    if ('{}=,;'.includes(c)) { tokens.push({ t: c }); i++; continue }
    if (c === '[') {
      const long = src.slice(i).match(/^\[(=*)\[/)
      if (long) { // long string [[…]] / [==[…]==]
        const close = ']' + long[1] + ']'
        const start = i + long[0].length
        const end = src.indexOf(close, start)
        if (end < 0) throw new Error('Not a valid .lrtemplate file.')
        tokens.push({ t: 'str', v: src.slice(start, end).replace(/^\r?\n/, '') })
        i = end + close.length
        continue
      }
      tokens.push({ t: '[' }); i++; continue
    }
    if (c === ']') { tokens.push({ t: ']' }); i++; continue }
    if (c === '"' || c === "'") {
      let out = ''
      let j = i + 1
      for (; j < n && src[j] !== c; j++) {
        if (src[j] === '\\') {
          j++
          const e = src[j]
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : /\d/.test(e) ? (() => { const m = src.slice(j).match(/^\d{1,3}/)[0]; j += m.length - 1; return String.fromCharCode(Number(m)) })() : e
        } else out += src[j]
      }
      if (j >= n) throw new Error('Not a valid .lrtemplate file.')
      tokens.push({ t: 'str', v: out })
      i = j + 1
      continue
    }
    const num = src.slice(i).match(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)
    if (num) { tokens.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)
    if (id) { tokens.push({ t: 'id', v: id[0] }); i += id[0].length; continue }
    throw new Error('Not a valid .lrtemplate file.')
  }
  return tokens
}

/** Lua tables → { map: {key: value}, list: [values] }; strings, numbers, booleans as JS values. */
function parseLuaTables(src) {
  const tk = tokenizeLua(src)
  let p = 0
  const peek = () => tk[p]
  const expect = (t) => { if (tk[p]?.t !== t) throw new Error('Not a valid .lrtemplate file.'); p++ }
  function value(depth) {
    const tok = tk[p]
    if (!tok) throw new Error('Not a valid .lrtemplate file.')
    if (tok.t === '{') return table(depth + 1)
    if (tok.t === 'str' || tok.t === 'num') { p++; return tok.v }
    if (tok.t === 'id') {
      p++
      if (tok.v === 'true') return true
      if (tok.v === 'false') return false
      if (tok.v === 'nil') return null
      if (tok.v === 'ZSTR' && tk[p]?.t === 'str') return tk[p++].v // localisable string
      return null // any other identifier/expression: ignored, never evaluated
    }
    throw new Error('Not a valid .lrtemplate file.')
  }
  function table(depth) {
    if (depth > MAX_LUA_DEPTH) throw new Error('Preset file is too complex.')
    expect('{')
    const t = { map: Object.create(null), list: [] }
    while (peek() && peek().t !== '}') {
      const a = tk[p], b = tk[p + 1]
      if (a.t === 'id' && b?.t === '=') { p += 2; t.map[a.v] = value(depth) }
      else if (a.t === '[') { p++; const k = value(depth); expect(']'); expect('='); const v = value(depth); if (typeof k === 'string') t.map[k] = v; else t.list.push(v) }
      else t.list.push(value(depth))
      if (peek()?.t === ',' || peek()?.t === ';') p++
    }
    expect('}')
    return t
  }
  // Expect `s = { … }` (other top-level assignments are ignored).
  while (p < tk.length) {
    if (tk[p].t === 'id' && tk[p + 1]?.t === '=' && tk[p + 2]?.t === '{') { p += 2; return table(0) }
    p++
  }
  throw new Error('Not a valid .lrtemplate file.')
}

const isTable = (v) => !!v && typeof v === 'object' && 'map' in v

export function parseLrTemplate(text, fileName = 'Preset.lrtemplate') {
  const root = parseLuaTables(String(text))
  const settings = root.map.value?.map?.settings
  if (!isTable(settings)) throw new Error('No Lightroom develop settings found in this .lrtemplate.')
  const m = settings.map
  const raw = (name) => {
    const v = m[name]
    if (v === true) return 'True'
    if (v === false) return 'False'
    return typeof v === 'number' ? String(v) : typeof v === 'string' ? v : null
  }
  const reader = {
    raw,
    num: (name) => toNum(raw(name)),
    // Curves are flat { x1, y1, x2, y2, … } lists here.
    list: (name) => {
      const v = m[name]
      if (!isTable(v)) return []
      const nums = v.list.filter((x) => typeof x === 'number')
      const out = []
      for (let i = 0; i + 1 < nums.length; i += 2) out.push(`${nums[i]}, ${nums[i + 1]}`)
      return out
    },
    hasEntries: (name) => {
      const v = m[name]
      if (isTable(v)) return v.list.length > 0 || Object.keys(v.map).length > 0
      return !!(v && v !== 0 && v !== '0' && v !== 'False')
    },
    lookName: () => (isTable(m.Look) && typeof m.Look.map.Name === 'string' ? m.Look.map.Name : raw('CameraProfile')),
    title: () => {
      const t = root.map.title ?? root.map.internalName
      if (typeof t !== 'string') return null
      // Localised titles look like "$$$/AgPresets/…=Warm Tones" → the part after "=".
      return t.startsWith('$$$/') ? (t.split('=').slice(1).join('=') || null) : t
    },
  }
  return presetFromReader(reader, fileName)
}

// ---- .dng (Lightroom Mobile presets) --------------------------------------------------
// A DNG "preset" is a photo whose embedded XMP packet holds the develop settings. We only
// look for the packet's bytes — the image itself is never decoded.

const ascii = (str) => Uint8Array.from(str, (ch) => ch.charCodeAt(0))
const XMP_OPEN = ascii('<x:xmpmeta')
const XMP_CLOSE = ascii('</x:xmpmeta>')

function indexOfBytes(hay, needle, from) {
  const first = needle[0]
  outer: for (let i = hay.indexOf(first, from); i >= 0 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    for (let k = 1; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer
    return i
  }
  return -1
}

/** Every XMP packet in a binary file (DNG/TIFF/JPEG), as text. */
export function xmpPacketsFromBinary(bytes) {
  const out = []
  let from = 0
  while (out.length < 8) {
    const start = indexOfBytes(bytes, XMP_OPEN, from)
    if (start < 0) break
    const end = indexOfBytes(bytes, XMP_CLOSE, start)
    if (end < 0) break
    out.push(new globalThis.TextDecoder('utf-8').decode(bytes.subarray(start, end + XMP_CLOSE.length)))
    from = end + XMP_CLOSE.length
  }
  return out
}

export function parseDngPreset(bytes, fileName = 'Preset.dng') {
  const packets = xmpPacketsFromBinary(bytes)
  if (!packets.length) throw new Error('This DNG has no Lightroom settings inside.')
  let lastError = null
  for (const xmp of packets) {
    try { return parseXmpPreset(xmp, fileName) } catch (err) { lastError = err }
  }
  throw lastError || new Error('This DNG has no Lightroom settings inside.')
}
