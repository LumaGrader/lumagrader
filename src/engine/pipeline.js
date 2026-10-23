import { buildCurveLUT } from './curve'
import { buildRgbCurveLUTs } from './curvePoints'
import { applyRatioLinear, luminance, srgbDecode, srgbEncode } from './tone'
import { getLocalBaseMap, sampleLocalBase } from './localBase'
import { prepareSource } from './sourcePrep'
import { HSL_BANDS } from './hsl'
import { wbMatrixFor, isGradeActive, gradeUniforms, applyGrade, grainAmplitude, grainCells, grainAt, vignetteParams, vignetteWeight, applyVignette, satVibFactor, scaleChroma, lumaOf, linearToOklab, oklabToLinear } from './color'
import { buildToneLUT, buildZoneLUT, sampleZoneLUT, toneRGB, buildHSLTable, sampleHSLTable, colorMatrix, isGlobalToneActive, isLocalActive, ZONE } from './lrModel'
import { getProfileBias } from './colorProfiles'
import { renderTonalWebGL } from './webgl/renderer'

// Downscaled copy of an image, used for interactive editing so slider drags stay smooth
// even on large source photos. Full-resolution `img` is still used for export.
export function makePreviewSource(img, maxSize = 1600) {
  const w0 = img.naturalWidth, h0 = img.naturalHeight
  const scale = Math.min(1, maxSize / Math.max(w0, h0))
  const w = Math.max(1, Math.round(w0 * scale))
  const h = Math.max(1, Math.round(h0 * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)
  return canvas
}

// Draws `source` (an HTMLImageElement or HTMLCanvasElement) onto `canvas` with the full
// adjustment/tone/curve/LUT/HSL+vibrance/grade/vignette/grain pipeline applied.
// All per-pixel passes (curve, tone zones, custom curve points, 3D LUT, HSL+vibrance,
// grain) are combined into a single getImageData/putImageData cycle for performance.
export function renderImage(canvas, source, s, luts = {}, { forceCanvas = false } = {}) {
  // Safety net: an ImageBitmap would upload to WebGL upside down (UNPACK_FLIP_Y is ignored
  // for bitmaps). Callers should pass canvases; this converts (slowly) if one slips through.
  if (typeof globalThis.ImageBitmap !== 'undefined' && source instanceof globalThis.ImageBitmap) {
    console.warn('renderImage got an ImageBitmap; converting to canvas')
    const c = document.createElement('canvas')
    c.width = source.width
    c.height = source.height
    c.getContext('2d').drawImage(source, 0, 0)
    source = c
  }
  const src = prepareSource(source, s)
  // Compatibility mode (the preview's GPU kept failing): software rendering only.
  if (forceCanvas) {
    renderTonalCanvas2D(canvas, src, s, luts)
    return
  }
  let webglError
  try {
    renderTonalWebGL(canvas, src, s, luts)
    return
  } catch (err) {
    webglError = err
    console.warn('WebGL render failed, falling back to Canvas 2D:', err)
  }
  // A canvas that already holds a WebGL context can't give a 2D one — let the caller recover
  // (the preview swaps in a fresh canvas; renderToCanvas renders on a plain canvas).
  if (!canvas.getContext('2d')) throw webglError
  renderTonalCanvas2D(canvas, src, s, luts)
}

// One shared off-screen WebGL canvas for every "render and read back" job (histogram,
// preset thumbnails, before/after, export). Browsers allow only ~16 live WebGL contexts and
// silently kill the OLDEST one (the main preview) when exceeded, so never create a new
// canvas per render.
let scratchCanvas = null

/** Renders into the shared scratch canvas, then copies into `target` (a plain 2D canvas). */
export function renderToCanvas(target, source, s, luts = {}, { allowCanvasFallback = true } = {}) {
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas')
  try {
    renderImage(scratchCanvas, source, s, luts)
  } catch (err) {
    if (!allowCanvasFallback) {
      scratchCanvas = null
      throw err
    }
    // WebGL failed on the scratch canvas (too big / context lost): start a new scratch canvas
    // next time, and render this one with the Canvas 2D engine directly into the target.
    scratchCanvas = null
    console.warn('Scratch WebGL render failed — using Canvas 2D for this render.', err)
    renderTonalCanvas2D(target, prepareSource(source, s), s, luts)
    return target
  }
  target.width = scratchCanvas.width
  target.height = scratchCanvas.height
  const ctx = target.getContext('2d')
  ctx.clearRect(0, 0, target.width, target.height)
  ctx.drawImage(scratchCanvas, 0, 0)
  return target
}

/** Row-major 3×3 product a·b. */
function multiply3(a, b) {
  const o = new Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return o
}

// sRGB byte → linear, and linear → sRGB byte, for the 2D fallback's tone step.
const DECODE_LUT = Float32Array.from({ length: 256 }, (_, i) => srgbDecode(i / 255))
const ENCODE_LUT = Uint8ClampedArray.from({ length: 4096 }, (_, i) => Math.round(srgbEncode(i / 4095) * 255))
const encode255 = (y) => ENCODE_LUT[Math.min(4095, Math.max(0, Math.round(y * 4095)))]

// Canvas 2D reference implementation — kept as an automatic fallback for browsers/devices
// without WebGL2 support, or if the shader ever fails to compile.
function renderTonalCanvas2D(canvas, src, s, luts = {}) {
  const w = src.naturalWidth ?? src.width
  const h = src.naturalHeight ?? src.height
  // Same as the WebGL path: resizing (even to the same size) clears the canvas → flicker.
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')

  const profile = getProfileBias(s.colorProfile)
  const vib = (s.vibrance || 0) / 100
  const satOn = vib !== 0 // Saturation is part of the colour matrix below
  const profileContrast = profile.contrast || 0
  // Same Lightroom-matched tables as the WebGL path (lrModel.js), so both renderers match.
  const tone = {
    exposure: s.exposure || 0, blacks: s.blacks || 0, whites: s.whites || 0,
    contrast: Math.max(-100, Math.min(100, (s.contrast || 0) + profileContrast)),
    shadows: s.shadows || 0, highlights: s.highlights || 0,
  }
  const toneOn = isGlobalToneActive(tone)
  const toneLut = toneOn ? buildToneLUT(tone) : null
  const zoneLut = isLocalActive(tone) ? buildZoneLUT(tone) : null
  const baseMap = zoneLut ? getLocalBaseMap(src) : null
  const ev = tone.exposure
  const wbOnly = wbMatrixFor(s, profile.temp || 0)
  const cm = colorMatrix(Math.max(-100, s.saturation + (profile.saturation || 0)), s.calibration)
  const wb = cm && wbOnly ? multiply3(cm, wbOnly) : cm || wbOnly
  const linearOn = toneOn || !!zoneLut || !!wb
  const dehaze = (s.dehaze || 0) / 100
  ctx.clearRect(0, 0, w, h) // the canvas is no longer reset by resizing (transparent PNGs)
  ctx.drawImage(src, 0, 0)

  const curveLut = s.curve ? buildCurveLUT(s.curve) : null
  const curvePointsLut = buildRgbCurveLUTs(s) // RGB + R/G/B point curves, or null
  const cubeLut = s.lut && luts[s.lut] ? luts[s.lut] : null
  // Color Mixer per band (user + profile bias) → the same hue × chroma table as the shader.
  const bands = { hue: [], sat: [], lum: [] }
  HSL_BANDS.forEach((band) => {
    const b = (s.hsl && s.hsl[band]) || { h: 0, s: 0, l: 0 }
    const bias = (profile.hsl && profile.hsl[band]) || {}
    bands.hue.push(b.h + (bias.h || 0)); bands.sat.push(b.s + (bias.s || 0)); bands.lum.push(b.l + (bias.l || 0))
  })
  const hslActive = [...bands.hue, ...bands.sat, ...bands.lum].some((v) => v)
  const hslTable = hslActive ? buildHSLTable(bands) : null
  const grainAmt = s.grain > 0 ? grainAmplitude(s.grain) : 0
  const [cellsX, cellsY] = grainCells(w, h, s.grainSize ?? 25)
  const grainRough = (s.grainRoughness ?? 50) / 100
  const vig = vignetteParams(s)
  const grade = isGradeActive(s.colorGrade) ? gradeUniforms(s.colorGrade) : null
  const needsPixelPass = linearOn || satOn || dehaze || curveLut || curvePointsLut || cubeLut || hslActive || grade || grainAmt || vig.amount

  if (needsPixelPass) {
    const id = ctx.getImageData(0, 0, w, h)
    const d = id.data
    const n = cubeLut ? cubeLut.size - 1 : 0
    const mix = cubeLut ? s.lutStrength / 100 : 0
    const idx255 = (v) => Math.min(255, Math.max(0, Math.round(v * 255)))

    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255

      if (linearOn) {
        let lr = DECODE_LUT[d[i]], lg = DECODE_LUT[d[i + 1]], lb = DECODE_LUT[d[i + 2]]
        if (wb) {
          const R = wb[0] * lr + wb[1] * lg + wb[2] * lb
          const G = wb[3] * lr + wb[4] * lg + wb[5] * lb
          const B = wb[6] * lr + wb[7] * lg + wb[8] * lb
          lr = Math.max(0, R); lg = Math.max(0, G); lb = Math.max(0, B)
        }
        if (zoneLut) {
          const Y0 = luminance(lr, lg, lb)
          if (Y0 > 1e-8) {
            const px = (i >> 2) % w, py = ((i >> 2) / w) | 0
            const [A, B] = sampleLocalBase(baseMap, (px + 0.5) / w, (py + 0.5) / h)
            const v0 = Math.max(Math.log2(Y0), -14)
            const base = Math.min(6, Math.max(-14, A * v0 + B))
            const v = Math.min(6, Math.max(-14, ZONE.mix * base + (1 - ZONE.mix) * v0)) + ev
            const [gs, gh] = sampleZoneLUT(zoneLut, v)
            const k = Math.pow(2, gs + gh)
            const enc = (y) => (y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055)
            const [cr, cg, cb] = scaleChroma(enc(lr * k), enc(lg * k), enc(lb * k), Math.pow(2, -ZONE.shadowsChroma * gs - ZONE.highlightsChroma * gh))
            lr = srgbDecode(Math.max(0, cr)); lg = srgbDecode(Math.max(0, cg)); lb = srgbDecode(Math.max(0, cb))
          }
        }
        if (toneLut) [lr, lg, lb] = toneRGB(lr, lg, lb, toneLut)
        const [nr, ng, nb] = applyRatioLinear(lr, lg, lb, 1) // gamut fit
        r = encode255(nr) / 255; g = encode255(ng) / 255; b = encode255(nb) / 255
      }
      if (satOn) [r, g, b] = scaleChroma(r, g, b, satVibFactor(r, g, b, 0, vib))

      if (dehaze > 0) {
        r = (r - 0.5) * (1 + dehaze * 0.6) + 0.5; g = (g - 0.5) * (1 + dehaze * 0.6) + 0.5; b = (b - 0.5) * (1 + dehaze * 0.6) + 0.5
        r = Math.min(1, Math.max(0, r)); g = Math.min(1, Math.max(0, g)); b = Math.min(1, Math.max(0, b))
        const L = lumaOf(r, g, b), k = 1 + dehaze * 0.3
        r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k
      } else if (dehaze < 0) {
        const a = -dehaze, L = lumaOf(r, g, b)
        r += (L - r) * a * 0.3; g += (L - g) * a * 0.3; b += (L - b) * a * 0.3
        r += (0.8 - r) * a * 0.45; g += (0.8 - g) * a * 0.45; b += (0.8 - b) * a * 0.45
      }

      // LUT lookups need integer indices.
      if (curveLut) { r = curveLut[idx255(r)] / 255; g = curveLut[idx255(g)] / 255; b = curveLut[idx255(b)] / 255 }
      if (curvePointsLut) { r = curvePointsLut.r[idx255(r)] / 255; g = curvePointsLut.g[idx255(g)] / 255; b = curvePointsLut.b[idx255(b)] / 255 }

      if (cubeLut) {
        const ri = Math.round(Math.min(1, Math.max(0, r)) * n), gi = Math.round(Math.min(1, Math.max(0, g)) * n), bi = Math.round(Math.min(1, Math.max(0, b)) * n)
        const ci = (ri + cubeLut.size * gi + cubeLut.size * cubeLut.size * bi) * 3
        r += (cubeLut.data[ci] - r) * mix
        g += (cubeLut.data[ci + 1] - g) * mix
        b += (cubeLut.data[ci + 2] - b) * mix
      }

      if (hslActive) {
        const [L, a, bb] = linearToOklab(srgbDecode(Math.max(0, r)), srgbDecode(Math.max(0, g)), srgbDecode(Math.max(0, b)))
        const cc = Math.hypot(a, bb)
        if (cc > 1e-5) {
          let hd = (Math.atan2(bb, a) * 180) / Math.PI
          if (hd < 0) hd += 360
          const [dh, lc, ll] = sampleHSLTable(hslTable, hd, cc)
          const hr = ((hd + dh) * Math.PI) / 180, c2 = cc * Math.exp(lc)
          const [nr, ng, nb] = oklabToLinear(L * Math.exp(ll), Math.cos(hr) * c2, Math.sin(hr) * c2)
          const [fr, fg, fb] = applyRatioLinear(Math.max(0, nr), Math.max(0, ng), Math.max(0, nb), 1)
          r = srgbEncode(fr); g = srgbEncode(fg); b = srgbEncode(fb)
        }
      }

      if (grade) [r, g, b] = applyGrade(r, g, b, grade)

      if (grainAmt) {
        const px = (i >> 2) % w, py = ((i >> 2) / w) | 0
        const le = Math.min(1, Math.max(0, lumaOf(r, g, b)))
        const n = grainAt((px + 0.5) / w, (py + 0.5) / h, cellsX, cellsY, grainAmt, le, grainRough)
        r += n; g += n; b += n
      }
      if (vig.amount) {
        const px = (i >> 2) % w, py = ((i >> 2) / w) | 0
        ;[r, g, b] = applyVignette(r, g, b, vignetteWeight((px + 0.5) / w, (py + 0.5) / h, w, h, vig), vig)
      }
      r *= 255; g *= 255; b *= 255

      d[i] = r; d[i + 1] = g; d[i + 2] = b
    }
    ctx.putImageData(id, 0, 0)
  }


}
