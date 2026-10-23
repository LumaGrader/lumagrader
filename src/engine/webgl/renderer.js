import { createProgram, ensureRenderTarget } from './glCore'
import { VERT_SRC, FRAG_SRC, BLUR_FRAG_SRC, COMBINE_FRAG_SRC, MASK_FRAG_SRC, DETAIL_FRAG_SRC } from './shaders'
import { buildRgbCurveLUTs } from '../curvePoints'
import { brushMaskSource } from '../brushMaskStore'
import { rangeUniforms } from '../masks'
import { getProfileBias } from '../colorProfiles'
import { wbMatrixFor, isGradeActive, gradeUniforms, grainAmplitude, grainCells, vignetteParams } from '../color'
import { buildToneLUT, buildZoneLUT, buildHSLTable, colorMatrix, isGlobalToneActive, isLocalActive, TONE_LUT_SIZE, ZONE_LUT_SIZE, HSL_TABLE_WIDTH, HSL_TABLE_ROWS, ZONE } from '../lrModel'
import { getLocalBaseMap } from '../localBase'

const HSL_ORDER = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta']
const MAIN_UNIFORM_NAMES = [
  'u_image', 'u_curvePointsLUT', 'u_cubeLut', 'u_useCubeLut', 'u_useCurvePoints',
  'u_localLUT', 'u_globalLUT', 'u_gfCoef', 'u_hslTable', 'u_useTone', 'u_useLocal', 'u_exposureEV',
  'u_zoneMix', 'u_zoneChroma', 'u_zoneRange', 'u_sat', 'u_useWB', 'u_wbMatrix', 'u_curveStrength',
  'u_lutStrength', 'u_hslActive', 'u_vibrance',
  'u_gradeActive', 'u_gradeTint', 'u_gradeLum', 'u_gradeBlend', 'u_gradeBalance',
  'u_grain', 'u_grainCells', 'u_grainRough', 'u_vignette', 'u_vigParams', 'u_resolution', 'u_dehaze',
]

// One WebGL2 context + compiled programs + textures per <canvas> element, reused across
// renders (compiling shader programs per frame would defeat the purpose of using the GPU).
const stateMap = new WeakMap()

/** Frees a canvas's WebGL context right away instead of waiting for garbage collection. */
export function releaseCanvas(canvas) {
  const state = stateMap.get(canvas)
  if (!state) return
  canvas._released = true // our own loseContext() below must not look like a GPU failure
  state.gl.getExtension('WEBGL_lose_context')?.loseContext()
  stateMap.delete(canvas)
}

function bindQuad(gl, program, quad) {
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  const loc = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
}

// Largest image side this GPU can render in one piece (texture, renderbuffer and viewport
// limits). Phones are often 4096–8192; above it WebGL fails and the canvas stays blank.
let gpuMax = null
export function gpuMaxDimension() {
  if (gpuMax) return gpuMax
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return (gpuMax = 16384) // no WebGL2 → Canvas 2D path, no GPU limit
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS)
    gpuMax = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1])
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    gpuMax = 4096
  }
  return gpuMax
}

function getState(canvas) {
  let state = stateMap.get(canvas)
  if (state && !state.gl.isContextLost()) return state
  if (state) stateMap.delete(canvas) // context was lost (GPU memory / driver reset)

  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true })
  if (!gl) throw new Error('WebGL2 not supported in this browser')
  if (gl.isContextLost()) throw new Error('WebGL context lost')

  const program = createProgram(gl, VERT_SRC, FRAG_SRC)
  const blurProgram = createProgram(gl, VERT_SRC, BLUR_FRAG_SRC)
  const combineProgram = createProgram(gl, VERT_SRC, COMBINE_FRAG_SRC)
  const maskProgram = createProgram(gl, VERT_SRC, MASK_FRAG_SRC)
  const detailProgram = createProgram(gl, VERT_SRC, DETAIL_FRAG_SRC)

  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)

  const imageTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, imageTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const curveTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, curveTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))

  // Model tables (half float — filterable in WebGL2 without extensions), see lrModel.js:
  //   localTex (unit 3, RG16F): zone → (Shadows, Highlights) gain   globalTex (unit 4, R16F): tone curve
  //   gfTex    (unit 5, RG16F): guided-filter (A, B) map for the edge-aware local base
  //   hslTex   (unit 6, RGBA16F): Color Mixer hue × chroma table
  const makeFloatTex = (internal, format, data, w = 1) => {
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, 1, 0, format, gl.FLOAT, data)
    return t
  }
  const localTex = makeFloatTex(gl.RG16F, gl.RG, new Float32Array([0, 0]))
  const globalTex = makeFloatTex(gl.R16F, gl.RED, new Float32Array([0]))
  const gfTex = makeFloatTex(gl.RG16F, gl.RG, new Float32Array([0, 0]))
  const hslTex = makeFloatTex(gl.RGBA16F, gl.RGBA, new Float32Array([0, 0, 0, 1]))

  const cubeTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_3D, cubeTex)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 1, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]))

  const brushTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, brushTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, 1, 1, 0, gl.ALPHA, gl.UNSIGNED_BYTE, new Uint8Array([0]))

  const uniforms = {}
  for (const name of MAIN_UNIFORM_NAMES) uniforms[name] = gl.getUniformLocation(program, name)

  const blurUniforms = {
    u_image: gl.getUniformLocation(blurProgram, 'u_image'),
    u_direction: gl.getUniformLocation(blurProgram, 'u_direction'),
    u_texel: gl.getUniformLocation(blurProgram, 'u_texel'),
    u_radius: gl.getUniformLocation(blurProgram, 'u_radius'),
  }
  const combineUniforms = {
    u_original: gl.getUniformLocation(combineProgram, 'u_original'),
    u_blurred: gl.getUniformLocation(combineProgram, 'u_blurred'),
    u_amount: gl.getUniformLocation(combineProgram, 'u_amount'),
    u_mode: gl.getUniformLocation(combineProgram, 'u_mode'),
  }
  const detailUniforms = {
    u_original: gl.getUniformLocation(detailProgram, 'u_original'),
    u_blurred: gl.getUniformLocation(detailProgram, 'u_blurred'),
    u_mode: gl.getUniformLocation(detailProgram, 'u_mode'),
    u_amount: gl.getUniformLocation(detailProgram, 'u_amount'),
    u_detail: gl.getUniformLocation(detailProgram, 'u_detail'),
    u_masking: gl.getUniformLocation(detailProgram, 'u_masking'),
    u_contrast: gl.getUniformLocation(detailProgram, 'u_contrast'),
  }
  const maskUniforms = {
    u_image: gl.getUniformLocation(maskProgram, 'u_image'),
    u_maskType: gl.getUniformLocation(maskProgram, 'u_maskType'),
    u_linear: gl.getUniformLocation(maskProgram, 'u_linear'),
    u_radial: gl.getUniformLocation(maskProgram, 'u_radial'),
    u_brushMask: gl.getUniformLocation(maskProgram, 'u_brushMask'),
    u_blurredForSharpen: gl.getUniformLocation(maskProgram, 'u_blurredForSharpen'),
    u_useDetailBlur: gl.getUniformLocation(maskProgram, 'u_useDetailBlur'),
    u_sharpen: gl.getUniformLocation(maskProgram, 'u_sharpen'),
    u_denoise: gl.getUniformLocation(maskProgram, 'u_denoise'),
    u_feather: gl.getUniformLocation(maskProgram, 'u_feather'),
    u_amount: gl.getUniformLocation(maskProgram, 'u_amount'),
    u_invert: gl.getUniformLocation(maskProgram, 'u_invert'),
    u_exposure: gl.getUniformLocation(maskProgram, 'u_exposure'),
    u_contrast: gl.getUniformLocation(maskProgram, 'u_contrast'),
    u_saturation: gl.getUniformLocation(maskProgram, 'u_saturation'),
    u_temp: gl.getUniformLocation(maskProgram, 'u_temp'),
    u_resolution: gl.getUniformLocation(maskProgram, 'u_resolution'),
    u_rangeType: gl.getUniformLocation(maskProgram, 'u_rangeType'),
    u_rangeParams: gl.getUniformLocation(maskProgram, 'u_rangeParams'),
    u_rangeColor: gl.getUniformLocation(maskProgram, 'u_rangeColor'),
    u_showOverlay: gl.getUniformLocation(maskProgram, 'u_showOverlay'),
  }

  state = {
    gl, program, blurProgram, combineProgram, maskProgram, detailProgram, quad,
    imageTex, curveTex, localTex, globalTex, gfTex, hslTex, cubeTex, brushTex, uniforms, blurUniforms, combineUniforms, maskUniforms, detailUniforms,
    cachedLutName: null,
    targetA: {}, targetB: {}, targetC: {}, targetD: {}, targetE: {}, targetF: {},
  }
  stateMap.set(canvas, state)
  return state
}

/** Row-major 3×3 product a·b. */
function multiply3(a, b) {
  const o = new Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return o
}

function setMainUniforms(state, s, luts, source, w, h) {
  const { gl, imageTex, curveTex, cubeTex, uniforms } = state

  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, imageTex)
  // Upload the photo only when it changed: while a slider moves the pixels stay the same, and
  // re-uploading ~7 MB per frame was the main per-frame cost. Sources are never drawn into
  // after they are handed to the renderer (new edits → new canvas), so identity + size is enough.
  const w0 = source.naturalWidth ?? source.width, h0 = source.naturalHeight ?? source.height
  if (state.uploaded?.source !== source || state.uploaded.w !== w0 || state.uploaded.h !== h0) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    state.uploaded = { source, w: w0, h: h0 }
  }
  gl.uniform1i(uniforms.u_image, 0)

  // RGB + R/G/B point curves, pre-composed into one RGBA LUT (channel c reads component c).
  const curveLuts = buildRgbCurveLUTs(s)
  const curveActive = !!curveLuts
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, curveTex)
  if (curveActive) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, curveLuts.rgba)
  }
  gl.uniform1i(uniforms.u_curvePointsLUT, 1)
  gl.uniform1i(uniforms.u_useCurvePoints, curveActive ? 1 : 0)

  const cubeLutEntry = s.lut && luts[s.lut]
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_3D, cubeTex)
  if (cubeLutEntry && state.cachedLutName !== s.lut) {
    const { size, data } = cubeLutEntry
    const bytes = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) bytes[i] = Math.round(data[i] * 255)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, size, size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes)
    state.cachedLutName = s.lut
  }
  gl.uniform1i(uniforms.u_cubeLut, 2)
  gl.uniform1i(uniforms.u_useCubeLut, cubeLutEntry ? 1 : 0)

  const profile = getProfileBias(s.colorProfile)
  const effSaturation = s.saturation + (profile.saturation || 0)
  const profileContrast = profile.contrast || 0

  // Lightroom-matched tone (lrModel.js). Tables are rebuilt only when their sliders change;
  // the local-base map only when the source pixels change (cached per source object).
  const tone = {
    exposure: s.exposure || 0, blacks: s.blacks || 0, whites: s.whites || 0,
    contrast: Math.max(-100, Math.min(100, (s.contrast || 0) + profileContrast)),
    shadows: s.shadows || 0, highlights: s.highlights || 0,
  }
  const toneOn = isGlobalToneActive(tone)
  const localOn = isLocalActive(tone)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  const toneKey = [tone.exposure, tone.blacks, tone.whites, tone.contrast].join('|')
  if (toneOn && state.toneKey !== toneKey) {
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, state.globalTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, TONE_LUT_SIZE, 1, 0, gl.RED, gl.FLOAT, buildToneLUT(tone))
    state.toneKey = toneKey
  }
  const zoneKey = [tone.shadows, tone.highlights].join('|')
  if (localOn && state.zoneKey !== zoneKey) {
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, state.localTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, ZONE_LUT_SIZE, 1, 0, gl.RG, gl.FLOAT, buildZoneLUT(tone))
    state.zoneKey = zoneKey
  }
  if (localOn) {
    const map = getLocalBaseMap(source)
    if (state.gfMap !== map) {
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_2D, state.gfTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, map.width, map.height, 0, gl.RG, gl.FLOAT, map.data)
      state.gfMap = map
    }
  }

  // Color Mixer: band values (user + profile bias) → hue × chroma table.
  const bands = { hue: [], sat: [], lum: [] }
  HSL_ORDER.forEach((band) => {
    const b = (s.hsl && s.hsl[band]) || { h: 0, s: 0, l: 0 }
    const bias = (profile.hsl && profile.hsl[band]) || {}
    bands.hue.push(b.h + (bias.h || 0))
    bands.sat.push(b.s + (bias.s || 0))
    bands.lum.push(b.l + (bias.l || 0))
  })
  const hslActive = [...bands.hue, ...bands.sat, ...bands.lum].some((v) => v)
  const hslKey = JSON.stringify(bands)
  if (hslActive && state.hslKey !== hslKey) {
    gl.activeTexture(gl.TEXTURE6)
    gl.bindTexture(gl.TEXTURE_2D, state.hslTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, HSL_TABLE_WIDTH, HSL_TABLE_ROWS, 0, gl.RGBA, gl.FLOAT, buildHSLTable(bands))
    state.hslKey = hslKey
  }

  gl.activeTexture(gl.TEXTURE3)
  gl.bindTexture(gl.TEXTURE_2D, state.localTex)
  gl.activeTexture(gl.TEXTURE4)
  gl.bindTexture(gl.TEXTURE_2D, state.globalTex)
  gl.activeTexture(gl.TEXTURE5)
  gl.bindTexture(gl.TEXTURE_2D, state.gfTex)
  gl.activeTexture(gl.TEXTURE6)
  gl.bindTexture(gl.TEXTURE_2D, state.hslTex)
  gl.uniform1i(uniforms.u_localLUT, 3)
  gl.uniform1i(uniforms.u_globalLUT, 4)
  gl.uniform1i(uniforms.u_gfCoef, 5)
  gl.uniform1i(uniforms.u_hslTable, 6)
  gl.uniform1i(uniforms.u_useTone, toneOn ? 1 : 0)
  gl.uniform1i(uniforms.u_useLocal, localOn ? 1 : 0)
  gl.uniform1f(uniforms.u_exposureEV, tone.exposure)
  gl.uniform1f(uniforms.u_zoneMix, ZONE.mix)
  gl.uniform2f(uniforms.u_zoneChroma, ZONE.shadowsChroma, ZONE.highlightsChroma)
  gl.uniform2f(uniforms.u_zoneRange, ZONE.range[0], ZONE.range[1] - ZONE.range[0])
  // Saturation (and imported Calibration) are measured colour matrices, combined with the
  // white balance (Bradford adaptation in linear light — see color.js); Vibrance stays below.
  gl.uniform1f(uniforms.u_sat, 0)
  const wb = wbMatrixFor(s, profile.temp || 0) // RAW Kelvin/Tint + relative Temp/Tint
  const cm = colorMatrix(Math.max(-100, effSaturation), s.calibration)
  const m = cm && wb ? multiply3(cm, wb) : cm || wb
  gl.uniform1i(uniforms.u_useWB, m ? 1 : 0)
  if (m) {
    // GLSL mat3 is column-major: transpose our row-major matrix.
    gl.uniformMatrix3fv(uniforms.u_wbMatrix, false, new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]))
  }
  gl.uniform1f(uniforms.u_curveStrength, s.curve || 0)
  gl.uniform1f(uniforms.u_lutStrength, (s.lutStrength || 0) / 100)
  gl.uniform1i(uniforms.u_hslActive, hslActive ? 1 : 0)
  gl.uniform1f(uniforms.u_vibrance, (s.vibrance || 0) / 100)


  // Color Grading: 3 wheels + global in Oklab — see color.js.
  const gradeOn = isGradeActive(s.colorGrade)
  gl.uniform1i(uniforms.u_gradeActive, gradeOn ? 1 : 0)
  if (gradeOn) {
    const G = gradeUniforms(s.colorGrade)
    gl.uniform2fv(uniforms.u_gradeTint, new Float32Array(G.tints))
    gl.uniform1fv(uniforms.u_gradeLum, new Float32Array(G.lums))
    gl.uniform1f(uniforms.u_gradeBlend, G.blending)
    gl.uniform1f(uniforms.u_gradeBalance, G.balance)
  }

  gl.uniform1f(uniforms.u_grain, s.grain > 0 ? grainAmplitude(s.grain) : 0)
  gl.uniform2f(uniforms.u_grainCells, ...grainCells(w, h, s.grainSize ?? 25))
  gl.uniform1f(uniforms.u_grainRough, (s.grainRoughness ?? 50) / 100)
  const vig = vignetteParams(s)
  gl.uniform1f(uniforms.u_vignette, vig.amount)
  gl.uniform4f(uniforms.u_vigParams, vig.mid, vig.round, vig.feather, vig.highlights)
  gl.uniform2f(uniforms.u_resolution, w, h)
  gl.uniform1f(uniforms.u_dehaze, (s.dehaze || 0) / 100)
}

// Renders the full tonal/color/effects pipeline on the GPU, plus (if active) sharpening and
// noise reduction via a small chain of separable-Gaussian-blur + combine passes. Throws if
// WebGL2 is unavailable or a shader fails to compile — callers should catch and fall back.
export function renderTonalWebGL(canvas, source, s, luts) {
  const w = source.naturalWidth ?? source.width
  const h = source.naturalHeight ?? source.height
  const max = gpuMaxDimension()
  if (w > max || h > max) throw new Error(`Image ${w}×${h} exceeds this GPU's ${max}px limit`)
  // Only resize when the size really changes: assigning canvas.width/height — even to the
  // same value — reallocates and clears the drawing buffer, which flickers on phones when it
  // happens on every slider frame.
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h

  const state = getState(canvas)
  const { gl } = state

  gl.viewport(0, 0, w, h)

  gl.useProgram(state.program)
  bindQuad(gl, state.program, state.quad)
  setMainUniforms(state, s, luts, source, w, h)

  // `_fastPreview` (a slider is being dragged on the small proxy): pixel-level sharpening and
  // noise reduction are invisible at that size, so they're skipped until the slider is released.
  const fast = !!s._fastPreview
  const sharpenActive = !fast && (s.sharpen || 0) > 0
  const denoiseActive = !fast && (s.noiseReduction || 0) > 0
  const colorNoiseActive = !fast && (s.colorNoiseReduction || 0) > 0
  // Texture / Clarity / Dehaze are bipolar (negative = soften / add haze).
  const clarityActive = (s.clarity || 0) !== 0
  const textureActive = (s.texture || 0) !== 0
  const dehazeActive = (s.dehaze || 0) !== 0
  const masks = (s.masks || []).filter((m) => m.enabled !== false)

  if (!sharpenActive && !denoiseActive && !colorNoiseActive && !clarityActive && !textureActive && !dehazeActive && masks.length === 0) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    if (gl.isContextLost()) throw new Error('WebGL context lost while rendering (out of graphics memory?)')
    return
  }

  const A = ensureRenderTarget(gl, state.targetA, w, h)
  const B = ensureRenderTarget(gl, state.targetB, w, h)
  const C = ensureRenderTarget(gl, state.targetC, w, h)
  const D = ensureRenderTarget(gl, state.targetD, w, h)

  gl.bindFramebuffer(gl.FRAMEBUFFER, A.framebuffer)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  // A now holds the fully tonal/color-graded image.

  function blurPass(srcTex, dstTarget, direction, radius) {
    gl.useProgram(state.blurProgram)
    bindQuad(gl, state.blurProgram, state.quad)
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstTarget.framebuffer)
    gl.viewport(0, 0, dstTarget.width, dstTarget.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1i(state.blurUniforms.u_image, 0)
    gl.uniform2f(state.blurUniforms.u_direction, direction[0], direction[1])
    gl.uniform2f(state.blurUniforms.u_texel, 1 / dstTarget.width, 1 / dstTarget.height)
    gl.uniform1f(state.blurUniforms.u_radius, radius)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.viewport(0, 0, w, h)
  }

  function combinePass(originalTex, blurredTex, dstTarget, amount, mode) {
    gl.useProgram(state.combineProgram)
    bindQuad(gl, state.combineProgram, state.quad)
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstTarget ? dstTarget.framebuffer : null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, originalTex)
    gl.uniform1i(state.combineUniforms.u_original, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, blurredTex)
    gl.uniform1i(state.combineUniforms.u_blurred, 1)
    gl.uniform1f(state.combineUniforms.u_amount, amount)
    gl.uniform1i(state.combineUniforms.u_mode, mode)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  function detailPass(srcTarget, dstTarget, cfg) {
    const exclude = dstTarget ? [srcTarget, dstTarget] : [srcTarget]
    const [scratch1, scratch2] = [A, B, C, D].filter((t) => !exclude.includes(t))
    blurPass(srcTarget.texture, scratch1, [1, 0], cfg.radius)
    blurPass(scratch1.texture, scratch2, [0, 1], cfg.radius)

    gl.useProgram(state.detailProgram)
    bindQuad(gl, state.detailProgram, state.quad)
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstTarget ? dstTarget.framebuffer : null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTarget.texture)
    gl.uniform1i(state.detailUniforms.u_original, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, scratch2.texture)
    gl.uniform1i(state.detailUniforms.u_blurred, 1)
    gl.uniform1i(state.detailUniforms.u_mode, cfg.mode)
    gl.uniform1f(state.detailUniforms.u_amount, cfg.amount)
    gl.uniform1f(state.detailUniforms.u_detail, cfg.detail || 0)
    gl.uniform1f(state.detailUniforms.u_masking, cfg.masking || 0)
    gl.uniform1f(state.detailUniforms.u_contrast, cfg.contrast || 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  function maskPass(srcTarget, dstTarget, mask) {
    const srcTex = srcTarget.texture
    const adj = mask.adjustments || {}
    const sharpenAmt = (adj.sharpen || 0) / 100 // −1..1: negative softens
    const denoiseAmt = (adj.denoise || 0) / 100

    // Sharpen and denoise share ONE blur pass (radius biased toward whichever wants more
    // spread) rather than each getting their own — running both independently would need
    // 6 scratch buffers at once instead of 4. A shared blur is an approximation when both
    // are active together, but keeps the render-target budget sane.
    let blurredTex = null
    if (sharpenAmt !== 0 || denoiseAmt > 0) {
      const exclude = dstTarget ? [srcTarget, dstTarget] : [srcTarget]
      const [scratch1, scratch2] = [A, B, C, D].filter((t) => !exclude.includes(t))
      // In preview pixels (1600 px long side), scaled down on the smaller drag proxy so a
      // mask's Sharpness / Noise Reduction look the same while any slider is dragged.
      const radius = (1.0 + Math.max(Math.abs(sharpenAmt) * (sharpenAmt < 0 ? 4.0 : 2.0), denoiseAmt * 4.0)) * Math.min(1, Math.max(w, h) / 1600)
      blurPass(srcTex, scratch1, [1, 0], radius)
      blurPass(scratch1.texture, scratch2, [0, 1], radius)
      blurredTex = scratch2.texture
    }

    gl.useProgram(state.maskProgram)
    bindQuad(gl, state.maskProgram, state.quad)
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstTarget ? dstTarget.framebuffer : null)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1i(state.maskUniforms.u_image, 0)

    const typeIndex = { linear: 0, radial: 1, brush: 2, luminance: 3, color: 3 }[mask.type] ?? 0
    gl.uniform1i(state.maskUniforms.u_maskType, typeIndex)
    if (mask.type === 'linear') {
      gl.uniform4f(state.maskUniforms.u_linear, mask.linear.x1, mask.linear.y1, mask.linear.x2, mask.linear.y2)
    } else if (mask.type === 'radial') {
      const rx = mask.radial.rx ?? mask.radial.r
      const ry = mask.radial.ry ?? mask.radial.r
      gl.uniform4f(state.maskUniforms.u_radial, mask.radial.cx, mask.radial.cy, rx, ry)
    } else if (mask.type === 'brush') {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, state.brushTex)
      const canvas = brushMaskSource(mask) // painted pixels, softened by the mask's Feather
      if (canvas) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, canvas)
      }
      gl.uniform1i(state.maskUniforms.u_brushMask, 1)
    }

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, blurredTex || state.curveTex)
    gl.uniform1i(state.maskUniforms.u_blurredForSharpen, 2)
    gl.uniform1i(state.maskUniforms.u_useDetailBlur, blurredTex ? 1 : 0)
    gl.uniform1f(state.maskUniforms.u_sharpen, sharpenAmt * (sharpenAmt < 0 ? 0.9 : 1.5))
    gl.uniform1f(state.maskUniforms.u_denoise, denoiseAmt * 0.8)

    gl.uniform1i(state.maskUniforms.u_invert, mask.invert ? 1 : 0)
    gl.uniform1f(state.maskUniforms.u_feather, (mask.feather ?? 100) / 100)
    gl.uniform1f(state.maskUniforms.u_amount, Math.min(100, Math.max(0, mask.amount ?? 100)) / 100)
    gl.uniform1f(state.maskUniforms.u_exposure, (adj.exposure || 0) / 100)
    gl.uniform1f(state.maskUniforms.u_contrast, (adj.contrast || 0) / 100)
    gl.uniform1f(state.maskUniforms.u_saturation, (adj.saturation || 0) / 100)
    gl.uniform1f(state.maskUniforms.u_temp, (adj.temp || 0) / 100)
    gl.uniform2f(state.maskUniforms.u_resolution, w, h)
    const range = rangeUniforms(mask.range)
    gl.uniform1i(state.maskUniforms.u_rangeType, range.type)
    gl.uniform4f(state.maskUniforms.u_rangeParams, ...range.params)
    gl.uniform3f(state.maskUniforms.u_rangeColor, ...range.color)
    gl.uniform1i(state.maskUniforms.u_showOverlay, s._maskOverlayId === mask.id ? 1 : 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // Chained in this order: broad local-contrast (Texture, Clarity) first, then edge
  // sharpening, then noise smoothing, then local masks last (masks apply on top of
  // everything else, matching how Lightroom layers local adjustments over the develop
  // settings). Each "blur" entry reuses the same blur+combine shape; mode 0 = unsharp-style
  // push-away-from-blur, mode 1 = blend-toward-blur.
  const passes = []
  // Presence: luminance-only (no colour shifts), radii in "preview pixels" (1600 px long
  // side) and blurred at that scale, so the preview and a full-size export look the same.
  // Negative amounts soften (move toward the blur) / add haze.
  if (dehazeActive) passes.push({ kind: 'blur', radius: 40.0, amount: s.dehaze / 100, mode: 4 })
  if (textureActive) passes.push({ kind: 'blur', radius: 2.5, amount: (s.texture / 100) * (s.texture > 0 ? 1.6 : 1.0), mode: 3 })
  if (clarityActive) passes.push({ kind: 'blur', radius: 18.0, amount: (s.clarity / 100) * (s.clarity > 0 ? 1.3 : 0.9), mode: 2 })
  if (sharpenActive) {
    const radiusBase = s.sharpenRadius ?? 1.0
    const detailShrink = 1 - ((s.sharpenDetail ?? 25) / 100) * 0.5 // higher Detail -> smaller effective radius, finer texture
    passes.push({
      kind: 'detail',
      radius: Math.max(0.3, radiusBase * detailShrink),
      mode: 0,
      amount: (s.sharpen / 100) * 1.5,
      masking: (s.sharpenMasking ?? 0) / 100,
    })
  }
  if (denoiseActive) {
    passes.push({
      kind: 'detail',
      radius: 1.0 + (s.noiseReduction / 100) * 4.0,
      mode: 1,
      amount: (s.noiseReduction / 100) * 0.8,
      detail: (s.denoiseDetail ?? 50) / 100,
      contrast: (s.denoiseContrast ?? 0) / 100,
    })
  }
  if (colorNoiseActive) {
    passes.push({
      kind: 'detail',
      radius: 1.0 + ((s.colorNoiseSmoothness ?? 50) / 100) * 6.0,
      mode: 2,
      amount: (s.colorNoiseReduction / 100) * 0.9,
      detail: (s.colorNoiseDetail ?? 50) / 100,
    })
  }
  masks.forEach((m) => passes.push({ kind: 'mask', mask: m }))

  let sourceTarget = A
  passes.forEach((pass, i) => {
    const isLast = i === passes.length - 1
    if (pass.kind === 'blur') {
      // Blur at preview scale (≤1600 px long side) in two small targets; the combine pass
      // samples it with linear filtering (smooth upscale).
      const ds = Math.max(1, Math.max(w, h) / 1600)
      const sw = Math.max(1, Math.ceil(w / ds)), sh = Math.max(1, Math.ceil(h / ds))
      const E = ensureRenderTarget(gl, state.targetE, sw, sh)
      const F = ensureRenderTarget(gl, state.targetF, sw, sh)
      // Softening shows the sparse 9-tap kernel as ghost copies at large radii, so large
      // radii / negative amounts run several smaller blurs (Gaussians compose: σ = √n · σᵢ).
      const iterations = pass.amount < 0 || pass.radius > 12 ? 3 : 1
      // Radii are in preview pixels (1600 px long side). Images smaller than that — the
      // ≤720 px proxy used while a slider is dragged — scale the radius down, so Dehaze /
      // Clarity / Texture look the same while dragging as after release.
      const r = (pass.radius * Math.min(1, Math.max(w, h) / 1600)) / Math.sqrt(iterations)
      blurPass(sourceTarget.texture, E, [1, 0], r)
      blurPass(E.texture, F, [0, 1], r)
      for (let k = 1; k < iterations; k++) {
        blurPass(F.texture, E, [1, 0], r)
        blurPass(E.texture, F, [0, 1], r)
      }
      if (isLast) {
        combinePass(sourceTarget.texture, F.texture, null, pass.amount, pass.mode)
      } else {
        const dest = [A, B, C, D].find((t) => t !== sourceTarget)
        combinePass(sourceTarget.texture, F.texture, dest, pass.amount, pass.mode)
        sourceTarget = dest
      }
    } else if (pass.kind === 'detail') {
      const dest = isLast ? null : [A, B, C, D].find((t) => t !== sourceTarget)
      detailPass(sourceTarget, dest, pass)
      if (!isLast) sourceTarget = dest
    } else {
      const dest = isLast ? null : [A, B, C, D].find((t) => t !== sourceTarget)
      maskPass(sourceTarget, dest, pass.mask)
      if (!isLast) sourceTarget = dest
    }
  })
  if (gl.isContextLost()) throw new Error('WebGL context lost while rendering (out of graphics memory?)')
}
