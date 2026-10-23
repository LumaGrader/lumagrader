// Color: Lightroom-like White Balance, Vibrance/Saturation and HSL.
// The same math runs in the WebGL shader (webgl/shaders.js) and in the Canvas 2D fallback
// (pipeline.js), which calls the JS functions below per pixel.
//
// White balance
//   Temp/Tint are relative to the photo's own white (0/0 = as shot — for RAWs LibRaw already
//   applied the camera's white balance). A slider value is read as "the light was actually
//   this colour", and the image is chromatically adapted (Bradford) from that illuminant to
//   the neutral one — the same model a RAW converter uses, done in linear light, so whites
//   and greys shift cleanly without the muddy cast of an overlay tint.
//   Temp −100 ≈ light assumed at ~3,500 K (cools); +100 is the mirror-image warming
//   (the inverse of a −85 cooling), so both ends feel about equally strong.
//   Tint ±100 ≈ ±0.03 Duv off the daylight locus (+ = magenta, like Lightroom).
//
// Saturation / Vibrance
//   Chroma is scaled around each pixel's luma, never past the sRGB gamut edge (no clipped,
//   hue-shifted channels). Saturation is uniform (−100 = grey, +100 ≈ 2×). Vibrance boosts
//   muted colours much more than already-saturated ones and protects skin tones.
//
// HSL
//   Eight bands with overlapping weights that add up to 1 around the whole hue circle (no
//   dead zones between bands), faded out for near-greys so neutrals never pick up a band's
//   adjustment. Hue ±100 = ±30°, Saturation −100…+100 = grey…2×, Luminance ±100 ≈ ∓/± 1.2 EV
//   on that colour (in linear light, keeping its saturation).

// ---- White balance --------------------------------------------------------------------

const REF_KELVIN = 6504
const REF_MIRED = 1e6 / REF_KELVIN

/** Slider (−100…100) → the illuminant colour temperature the image is corrected from. */
export function tempToKelvin(temp) {
  const t = Math.max(-100, Math.min(100, Number(temp) || 0))
  const mired = REF_MIRED - 1.3 * t
  return 1e6 / mired
}

/** CIE 1931 xy of a Planckian (black-body) radiator — Kim et al. cubic spline, 1667–25000 K. */
function planckXY(T) {
  T = Math.max(1667, Math.min(25000, T))
  const t1 = 1e3 / T, t2 = t1 * t1, t3 = t2 * t1
  const x = T <= 4000
    ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t1 + 0.17991
    : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t1 + 0.24039
  const x2 = x * x, x3 = x2 * x
  const y = T <= 2222
    ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
    : T <= 4000
      ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
      : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483
  return [x, y]
}

const xyToUv = ([x, y]) => { const d = -2 * x + 12 * y + 3; return [4 * x / d, 6 * y / d] }
const uvToXy = ([u, v]) => { const d = 2 * u - 8 * v + 4; return [3 * u / d, 2 * v / d] }

/** Illuminant chromaticity (xy) for a temperature and a Duv offset (+ = greener light). */
function illuminantXY(kelvin, duv) {
  const [u, v] = xyToUv(planckXY(kelvin))
  if (!duv) return uvToXy([u, v])
  // Unit normal to the locus in uv (numerical tangent), pointing to the green side (+v).
  const [u1, v1] = xyToUv(planckXY(kelvin * 0.995))
  const [u2, v2] = xyToUv(planckXY(kelvin * 1.005))
  let nu = -(v2 - v1), nv = u2 - u1
  const len = Math.hypot(nu, nv) || 1
  nu /= len; nv /= len
  if (nv < 0) { nu = -nu; nv = -nv }
  return uvToXy([u + nu * duv, v + nv * duv])
}

const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y]

const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296]
const BRADFORD_INV = [0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428, 0.9684867]
const SRGB_TO_XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041]
const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252]

function mul3(a, b) {
  const o = new Array(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return o
}
const apply3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]

/**
 * 3×3 matrix (row-major) applied to LINEAR sRGB for Temp/Tint, or null when neutral.
 * Normalised so a neutral grey keeps its luminance (white balance never changes exposure).
 */
export function whiteBalanceMatrix(temp, tint) {
  const t = Math.max(-100, Math.min(100, Number(temp) || 0))
  const n = Math.max(-100, Math.min(100, Number(tint) || 0))
  if (!t && !n) return null
  // Warming mirrors cooling (inverse adaptation): along the black-body locus a warm "as if
  // the light were bluer" correction runs out of room above ~20,000 K and felt weak, so
  // +t is the exact inverse of the −WARM_MIRROR·t cooling correction instead.
  const coolT = t > 0 ? -WARM_MIRROR * t : t
  const src = xyToXYZ(illuminantXY(tempToKelvin(coolT), (n / 100) * 0.03))
  const dst = xyToXYZ(illuminantXY(REF_KELVIN, 0))
  let m = adaptMatrix(src, dst)
  if (t > 0) {
    // Undo the cooling (temp only), keep the tint part: inverse(cool) · tintOnly.
    const coolOnly = adaptMatrix(xyToXYZ(illuminantXY(tempToKelvin(coolT), 0)), dst)
    const tintOnly = n ? adaptMatrix(xyToXYZ(illuminantXY(REF_KELVIN, (n / 100) * 0.03)), dst) : IDENTITY
    m = mul3(invert3(coolOnly), tintOnly)
  }
  const g = apply3(m, [1, 1, 1])
  const y = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]
  return m.map((v) => v / y)
}

const WARM_MIRROR = 0.85
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Bradford adaptation from white `src` to white `dst` (XYZ), as a linear-sRGB matrix. */
function adaptMatrix(src, dst) {
  const cs = apply3(BRADFORD, src), cd = apply3(BRADFORD, dst)
  const scale = [cd[0] / cs[0], 0, 0, 0, cd[1] / cs[1], 0, 0, 0, cd[2] / cs[2]]
  return mul3(XYZ_TO_SRGB, mul3(mul3(BRADFORD_INV, mul3(scale, BRADFORD)), SRGB_TO_XYZ))
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det)
}

// ---- Kelvin white balance for RAW photos (Lightroom-style Temp in K + Tint) -------------
// Same conventions as Adobe's DNG SDK (dng_temperature): Robertson's isotherm table maps a
// chromaticity to a correlated colour temperature, and Tint is the distance off the
// black-body locus × −3000 (+ = the light is greener → the photo turns magenta). So the
// numbers line up with Lightroom's for the same camera white point.

// Robertson (1968): [mired, u, v, isotherm slope]
const ROBERTSON = [
  [0, 0.18006, 0.26352, -0.24341], [10, 0.18066, 0.26589, -0.25479], [20, 0.18133, 0.26846, -0.26876],
  [30, 0.18208, 0.27119, -0.28539], [40, 0.18293, 0.27407, -0.3047], [50, 0.18388, 0.27709, -0.32675],
  [60, 0.18494, 0.28021, -0.35156], [70, 0.18611, 0.28342, -0.37915], [80, 0.1874, 0.28668, -0.40955],
  [90, 0.1888, 0.28997, -0.44278], [100, 0.19032, 0.29326, -0.47888], [125, 0.19462, 0.30141, -0.58204],
  [150, 0.19962, 0.30921, -0.70471], [175, 0.20525, 0.31647, -0.84901], [200, 0.21142, 0.32312, -1.0182],
  [225, 0.21807, 0.32909, -1.2168], [250, 0.22511, 0.33439, -1.4512], [275, 0.23247, 0.33904, -1.7298],
  [300, 0.2401, 0.34308, -2.0637], [325, 0.24792, 0.34655, -2.4681], [350, 0.25591, 0.34951, -2.9641],
  [375, 0.264, 0.352, -3.5814], [400, 0.27218, 0.35407, -4.3633], [425, 0.28039, 0.35577, -5.3762],
  [450, 0.28863, 0.35714, -6.7262], [475, 0.29685, 0.35823, -8.5955], [500, 0.30505, 0.35907, -11.324],
  [525, 0.3132, 0.35968, -15.628], [550, 0.32129, 0.36011, -23.325], [575, 0.32931, 0.36038, -40.77],
  [600, 0.33724, 0.36051, -116.45],
]
const TINT_SCALE = -3000
export const KELVIN_MIN = 2000
export const KELVIN_MAX = 50000
export const RAW_TINT_MAX = 150

const unitSlope = (t) => { const len = Math.hypot(1, t); return [1 / len, t / len] }

/** Chromaticity (xy) → { kelvin, tint } (DNG SDK / Lightroom convention). */
export function xyToTempTint([x, y]) {
  const [u, v] = xyToUv([x, y])
  let lastDt = 0, lastDu = 0, lastDv = 0
  for (let i = 1; i < ROBERTSON.length; i++) {
    let [du, dv] = unitSlope(ROBERTSON[i][3])
    const uu = u - ROBERTSON[i][1], vv = v - ROBERTSON[i][2]
    let dt = -uu * dv + vv * du
    if (dt <= 0 || i === ROBERTSON.length - 1) {
      if (dt > 0) dt = 0
      dt = -dt
      const f = i === 1 ? 0 : dt / (lastDt + dt)
      const kelvin = 1e6 / (ROBERTSON[i - 1][0] * f + ROBERTSON[i][0] * (1 - f))
      const u0 = ROBERTSON[i - 1][1] * f + ROBERTSON[i][1] * (1 - f)
      const v0 = ROBERTSON[i - 1][2] * f + ROBERTSON[i][2] * (1 - f)
      du = du * (1 - f) + lastDu * f
      dv = dv * (1 - f) + lastDv * f
      const len = Math.hypot(du, dv)
      const tint = ((u - u0) * du / len + (v - v0) * dv / len) * TINT_SCALE
      return { kelvin, tint }
    }
    lastDt = dt; lastDu = du; lastDv = dv
  }
  return { kelvin: 5000, tint: 0 }
}

/** { kelvin, tint } → chromaticity (xy). */
export function tempTintToXY(kelvin, tint) {
  const r = 1e6 / Math.max(KELVIN_MIN * 0.5, kelvin)
  const offset = (Number(tint) || 0) / TINT_SCALE
  const n = ROBERTSON.length
  for (let i = 0; i < n - 1; i++) {
    if (r < ROBERTSON[i + 1][0] || i === n - 2) {
      const f = (ROBERTSON[i + 1][0] - r) / (ROBERTSON[i + 1][0] - ROBERTSON[i][0])
      let u = ROBERTSON[i][1] * f + ROBERTSON[i + 1][1] * (1 - f)
      let v = ROBERTSON[i][2] * f + ROBERTSON[i + 1][2] * (1 - f)
      const [u1, v1] = unitSlope(ROBERTSON[i][3])
      const [u2, v2] = unitSlope(ROBERTSON[i + 1][3])
      let du = u1 * f + u2 * (1 - f), dv = v1 * f + v2 * (1 - f)
      const len = Math.hypot(du, dv)
      du /= len; dv /= len
      u += du * offset
      v += dv * offset
      return uvToXy([u, v])
    }
  }
  return uvToXy([ROBERTSON[n - 1][1], ROBERTSON[n - 1][2]])
}

// Lightroom interpolates each camera's two colour matrices (tungsten + daylight) by the white
// point's temperature; LibRaw only carries the daylight (D65) one, which reads warm-light
// scenes a little high in Kelvin. Displayed/stored Kelvin is put on Lightroom's scale with a
// correction that is zero at D65 and grows toward warm light (in mired, 1e6/K):
//   mired_LR = mired + LR_MIRED_SLOPE · (mired − mired_D65)
// Fitted to one Canon RAW (5106 K here vs 4900 K in Lightroom). One data point — refine later.
const LR_MIRED_SLOPE = 0.198
const D65_MIRED = 1e6 / 6504
// Same idea for Tint (same RAW: +3 here vs +6 in Lightroom at ~4900 K): an offset that is
// zero at D65 and proportional to the mired distance from it.
const LR_TINT_PER_MIRED = 3 / (1e6 / 5106 - 1e6 / 6504)
/** Physical tint at physical CCT k → Lightroom-scale tint. */
export const toLightroomTint = (tint, k) => tint + LR_TINT_PER_MIRED * (1e6 / k - D65_MIRED)
/** Lightroom-scale tint at physical CCT k → physical tint. */
export const fromLightroomTint = (tint, k) => tint - LR_TINT_PER_MIRED * (1e6 / k - D65_MIRED)
/** Physical CCT (from the D65 matrix) → Lightroom-scale Kelvin. */
export const toLightroomKelvin = (k) => { const m = 1e6 / k; return 1e6 / (m + LR_MIRED_SLOPE * (m - D65_MIRED)) }
/** Lightroom-scale Kelvin → physical CCT used for the colour maths. */
export const fromLightroomKelvin = (k) => { const m = 1e6 / k; return 1e6 / ((m + LR_MIRED_SLOPE * D65_MIRED) / (1 + LR_MIRED_SLOPE)) }

/**
 * The camera's "As Shot" white balance from LibRaw colour data: the neutral the camera
 * recorded (1 / WB multipliers, in camera RGB) → XYZ via the camera's Adobe colour matrix
 * (cam_xyz: XYZ → camera) → Kelvin/Tint. Null when the file lacks the data.
 */
export function asShotFromLibRaw(color) {
  const mul = color?.cam_mul, cx = color?.cam_xyz
  if (!mul || !cx || !(mul[0] > 0 && mul[1] > 0 && mul[2] > 0)) return null
  const m = [cx[0][0], cx[0][1], cx[0][2], cx[1][0], cx[1][1], cx[1][2], cx[2][0], cx[2][1], cx[2][2]]
  if (!m.every(Number.isFinite) || m.every((v) => v === 0)) return null
  const neutral = [1 / mul[0], 1 / mul[1], 1 / mul[2]]
  const XYZ = apply3(invert3(m), neutral)
  const sum = XYZ[0] + XYZ[1] + XYZ[2]
  if (!(sum > 0) || XYZ.some((v) => !Number.isFinite(v))) return null
  const res = xyToTempTint([XYZ[0] / sum, XYZ[1] / sum])
  if (!(res.kelvin >= KELVIN_MIN * 0.75 && res.kelvin <= KELVIN_MAX)) return null
  // Lightroom-scale Kelvin, rounded like Lightroom shows it (50 K steps; 100 K above 10,000 K).
  const lrK = toLightroomKelvin(res.kelvin)
  const step = lrK < 10000 ? 50 : 100
  return { kelvin: Math.round(lrK / step) * step, tint: Math.round(toLightroomTint(res.tint, res.kelvin)), physical: Math.round(res.kelvin) }
}

/** Kelvin slider position (0…1000, logarithmic like Lightroom's) ↔ Kelvin. */
export const kelvinToPos = (k) => Math.round((Math.log(Math.min(KELVIN_MAX, Math.max(KELVIN_MIN, k)) / KELVIN_MIN) / Math.log(KELVIN_MAX / KELVIN_MIN)) * 1000)
export const posToKelvin = (p) => {
  const k = KELVIN_MIN * Math.pow(KELVIN_MAX / KELVIN_MIN, Math.min(1000, Math.max(0, p)) / 1000)
  return Math.round(k / (k < 10000 ? 50 : 100)) * (k < 10000 ? 50 : 100)
}

/**
 * White-balance matrix for a whole settings object (linear sRGB, row-major) or null:
 *  - RAW with `wb` { kelvin, tint } set: re-balance from the as-shot white to the chosen
 *    one. The photo was rendered neutral for the as-shot light, so the new rendering is a
 *    Bradford adaptation from the NEW white to the AS-SHOT white (raising Kelvin warms).
 *  - plus the relative Temp/Tint (JPEGs, presets), applied on top.
 * `s.asShotWB` is attached per photo by effectiveSettings() (panels.js).
 */
export function wbMatrixFor(s, profileTemp = 0) {
  let abs = null
  if (s.wb && s.asShotWB) {
    const k = Math.min(KELVIN_MAX, Math.max(KELVIN_MIN, Number(s.wb.kelvin) || s.asShotWB.kelvin))
    const t = Math.min(RAW_TINT_MAX, Math.max(-RAW_TINT_MAX, Number(s.wb.tint) || 0))
    if (Math.abs(k - s.asShotWB.kelvin) > 0.5 || Math.abs(t - s.asShotWB.tint) > 0.05) {
      // Kelvin values are on Lightroom's scale → back to physical CCT for the maths.
      const kNew = fromLightroomKelvin(k), kShot = fromLightroomKelvin(s.asShotWB.kelvin)
      const m = adaptMatrix(
        xyToXYZ(tempTintToXY(kNew, fromLightroomTint(t, kNew))),
        xyToXYZ(tempTintToXY(kShot, fromLightroomTint(s.asShotWB.tint, kShot))),
      )
      const g = apply3(m, [1, 1, 1])
      const y = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]
      abs = m.map((v) => v / y)
    }
  }
  const rel = whiteBalanceMatrix((s.temp || 0) + profileTemp, s.tint || 0)
  if (abs && rel) return mul3(rel, abs)
  return abs || rel
}

// ---- White balance eyedropper ---------------------------------------------------------

/** Minimises f over a 2-D box with Nelder–Mead (small, derivative-free; f is cheap). */
function minimize2D(f, start, lo, hi, step) {
  const clampP = (p) => [Math.min(hi[0], Math.max(lo[0], p[0])), Math.min(hi[1], Math.max(lo[1], p[1]))]
  let pts = [clampP(start), clampP([start[0] + step[0], start[1]]), clampP([start[0], start[1] + step[1]])]
  let vals = pts.map(f)
  for (let it = 0; it < 200; it++) {
    const order = [0, 1, 2].sort((a, b) => vals[a] - vals[b])
    pts = order.map((i) => pts[i]); vals = order.map((i) => vals[i])
    if (vals[2] - vals[0] < 1e-12) break
    const c = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2]
    const at = (k) => clampP([c[0] + k * (pts[2][0] - c[0]), c[1] + k * (pts[2][1] - c[1])])
    const r = at(-1), fr = f(r)
    if (fr < vals[0]) {
      const e = at(-2), fe = f(e)
      if (fe < fr) { pts[2] = e; vals[2] = fe } else { pts[2] = r; vals[2] = fr }
    } else if (fr < vals[1]) { pts[2] = r; vals[2] = fr } else {
      const k = at(0.5), fk = f(k)
      if (fk < vals[2]) { pts[2] = k; vals[2] = fk } else {
        for (const i of [1, 2]) { pts[i] = [(pts[i][0] + pts[0][0]) / 2, (pts[i][1] + pts[0][1]) / 2]; vals[i] = f(pts[i]) }
      }
    }
  }
  const best = vals[0] <= vals[1] && vals[0] <= vals[2] ? 0 : vals[1] <= vals[2] ? 1 : 2
  return { p: pts[best], value: vals[best] }
}

// How far a linear RGB colour is from neutral (log chromaticity ratios).
const castOf = ([r, g, b]) => {
  const e = 1e-6
  const lr = Math.log(Math.max(e, r) / Math.max(e, g)), lb = Math.log(Math.max(e, b) / Math.max(e, g))
  return lr * lr + lb * lb
}

/**
 * White balance eyedropper: the settings that make `linearRGB` (a colour sampled from the
 * photo with NO white balance applied — linear sRGB) neutral grey.
 * RAW (s.asShotWB set): returns { wb: { kelvin, tint } | null } on Lightroom's Kelvin scale.
 * JPEG: returns { temp, tint } (relative −100…+100).
 * `clipped` is true when the picked colour can't be fully neutralised within the slider range.
 */
export function solveWhiteBalance(linearRGB, s, profileTemp = 0) {
  if (s.asShotWB) {
    const shot = s.asShotWB
    const matFor = (p) => wbMatrixFor({ ...s, wb: { kelvin: posToKelvinExact(p[0]), tint: p[1] } }, profileTemp) || IDENTITY
    const f = (p) => castOf(apply3(matFor(p), linearRGB))
    const cur = s.wb || shot
    const { p, value } = minimize2D(f, [kelvinToPosExact(cur.kelvin), cur.tint], [0, -RAW_TINT_MAX], [1000, RAW_TINT_MAX], [60, 20])
    const kelvinRaw = posToKelvinExact(p[0])
    const kelvin = Math.round(kelvinRaw / (kelvinRaw < 10000 ? 10 : 50)) * (kelvinRaw < 10000 ? 10 : 50)
    const tint = Math.round(p[1])
    const same = Math.abs(kelvin - shot.kelvin) < 1 && Math.abs(tint - shot.tint) < 0.5
    return { wb: same ? null : { kelvin, tint }, clipped: value > 0.002 }
  }
  const f = (p) => castOf(apply3(whiteBalanceMatrix(p[0] + profileTemp, p[1]) || IDENTITY, linearRGB))
  const { p, value } = minimize2D(f, [s.temp || 0, s.tint || 0], [-100 - profileTemp, -100], [100 - profileTemp, 100], [20, 20])
  return { temp: Math.round(p[0]), tint: Math.round(p[1]), clipped: value > 0.002 }
}

const LOG_KELVIN_SPAN = Math.log(KELVIN_MAX / KELVIN_MIN)
const kelvinToPosExact = (k) => (Math.log(Math.min(KELVIN_MAX, Math.max(KELVIN_MIN, k)) / KELVIN_MIN) / LOG_KELVIN_SPAN) * 1000
const posToKelvinExact = (p) => KELVIN_MIN * Math.exp((Math.min(1000, Math.max(0, p)) / 1000) * LOG_KELVIN_SPAN)

// ---- Shared per-pixel helpers (values 0..1, sRGB-encoded unless noted) -----------------

export const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

const dec = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const enc = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)

/**
 * The grey a colour turns into when fully desaturated: its true luminance (linear light),
 * re-encoded. Pure blue → a dark-medium grey (not near-black as a gamma-space luma gives),
 * so Saturation −100 reads like a proper black & white conversion.
 */
export const greyOf = (r, g, b) => enc(lumaOf(dec(Math.max(0, r)), dec(Math.max(0, g)), dec(Math.max(0, b))))

/** Largest chroma factor that keeps L + (c − L)·k inside [0, 1] for every channel. */
export function maxChromaScale(r, g, b, L) {
  let k = Infinity
  for (const c of [r, g, b]) {
    const d = c - L
    if (d > 1e-6) k = Math.min(k, (1 - L) / d)
    else if (d < -1e-6) k = Math.min(k, L / -d)
  }
  return k
}

/** Scales chroma by k around the pixel's grey; boosts stop at the gamut edge instead of clipping. */
export function scaleChroma(r, g, b, k) {
  if (k === 1) return [r, g, b]
  const L = greyOf(r, g, b)
  if (k > 1) k = Math.min(k, Math.max(1, maxChromaScale(r, g, b, L)))
  k = Math.max(0, k)
  return [L + (r - L) * k, L + (g - L) * k, L + (b - L) * k]
}

/** HSV hue in degrees (0..360) and saturation (0..1). */
export function hueSat(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn
  if (c <= 1e-6) return [0, 0]
  let h
  if (mx === r) h = ((g - b) / c) % 6
  else if (mx === g) h = (b - r) / c + 2
  else h = (r - g) / c + 4
  h *= 60
  if (h < 0) h += 360
  return [h, mx > 0 ? c / mx : 0]
}

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/** Combined Saturation × Vibrance chroma factor for one pixel. sat, vib in −1..1. */
export function satVibFactor(r, g, b, sat, vib) {
  let k = 1 + sat
  if (vib) {
    const [h, s] = hueSat(r, g, b)
    if (vib > 0) {
      // Skin tones (orange-ish reds, ~15–45°) get about half the boost.
      let dh = Math.abs(h - 28); if (dh > 180) dh = 360 - dh
      const skin = Math.max(0, 1 - dh / 30) * smoothstep(0.08, 0.3, s)
      k *= 1 + vib * 1.3 * (1 - s) * (1 - s) * (1 - 0.55 * skin)
    } else {
      k *= 1 + vib * 0.85
    }
  }
  return k
}

// Color Mixer (HSL): Lightroom-matched hue × chroma tables, see lrModel.js.

/** Rebuilds RGB from hue (deg) keeping the pixel's max and min channel (HSV V and chroma). */
export function withHue(r, g, b, h) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rr, gg, bb
  if (hp < 1) [rr, gg, bb] = [c, x, 0]
  else if (hp < 2) [rr, gg, bb] = [x, c, 0]
  else if (hp < 3) [rr, gg, bb] = [0, c, x]
  else if (hp < 4) [rr, gg, bb] = [0, x, c]
  else if (hp < 5) [rr, gg, bb] = [x, 0, c]
  else [rr, gg, bb] = [c, 0, x]
  return [rr + mn, gg + mn, bb + mn]
}

// ---- Color Grading (Phase 3): Shadows / Midtones / Highlights / Global wheels -----------
// Lightroom-style: each wheel has Hue (0–360, standard hue circle: 0 red, 120 green, 240 blue),
// Saturation (0–100) and Luminance (−100…+100); Blending (0–100, default 50) widens the
// overlap between the tonal ranges and Balance (−100…+100) moves them (positive = more of
// the photo counts as highlights). Done in Oklab (perceptual): a wheel adds a chroma offset in
// the wheel's hue direction weighted by how much a pixel belongs to its range — tints the
// colour without changing its brightness — and Luminance shifts Oklab lightness.

export const GRADE_WHEELS = ['shadows', 'midtones', 'highlights', 'global']
export const defaultColorGrade = () => ({
  shadows: { h: 0, s: 0, l: 0 },
  midtones: { h: 0, s: 0, l: 0 },
  highlights: { h: 0, s: 0, l: 0 },
  global: { h: 0, s: 0, l: 0 },
  blending: 50,
  balance: 0,
})
// Calibrated to a Lightroom comparison (Shadows 200°/40, Highlights 40°/40):
// Lightroom's offset peaks at ≈0.025 Oklab chroma for Saturation 40, highlight Luminance +40
// lifts ≈0.028 L; its shadow range fades out below L≈0.3 and reaches up to L≈0.58, the
// highlight range starts at L≈0.6.
const GRADE_CHROMA = 0.06 // Oklab chroma offset at Saturation 100
const GRADE_LUM = 0.07 // Oklab lightness shift at Luminance ±100
const PROPHOTO_TO_SRGB = [2.034076, -0.727334, -0.306742, -0.228813, 1.23173, -0.002917, -0.00857, -0.153287, 1.161856]

export function isGradeActive(cg) {
  return !!cg && GRADE_WHEELS.some((k) => cg[k] && (cg[k].s || cg[k].l))
}

export function linearToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
export function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

/**
 * Unit Oklab (a, b) direction of a wheel hue. Lightroom's wheel hues live in its wide working
 * space, not sRGB: HSV(h, 0.8, 1) in ProPhoto primaries (gamma 1.3) matches the directions
 * measured from Lightroom within ~5° (hue 200 → cyan-teal, not sky blue).
 */
export function hueDirection(h) {
  const [r0, g0, b0] = withHue(1, 0, 0, h) // HSV (h, 1, 1)
  const pp = [r0, g0, b0].map((c) => Math.pow(1 - 0.8 * (1 - c), 1.3))
  const [r, g, b] = apply3(PROPHOTO_TO_SRGB, pp)
  const [, A, B] = linearToOklab(r, g, b)
  const len = Math.hypot(A, B) || 1
  return [A / len, B / len]
}

/** Per-render constants for the grade (also fed to the shader). */
export function gradeUniforms(cg) {
  const g = cg || defaultColorGrade()
  const tints = [], lums = []
  for (const k of GRADE_WHEELS) {
    const w = g[k] || { h: 0, s: 0, l: 0 }
    const [dx, dy] = hueDirection(w.h || 0)
    const amt = (Math.max(0, Math.min(100, w.s || 0)) / 100) * GRADE_CHROMA
    tints.push(dx * amt, dy * amt)
    lums.push((Math.max(-100, Math.min(100, w.l || 0)) / 100) * GRADE_LUM)
  }
  const blending = Math.max(0, Math.min(100, g.blending ?? 50)) / 100
  const balance = Math.max(-100, Math.min(100, g.balance ?? 0)) / 100
  return { tints, lums, blending, balance }
}

/** Range weights [shadows, midtones, highlights] for Oklab lightness L. */
export function gradeWeights(L, blending, balance) {
  const shift = -balance * 0.15
  const width = 0.06 + 0.22 * blending
  const ws = 1 - smoothstep(0.49 + shift - width, 0.49 + shift + width, L)
  const wh = smoothstep(0.66 + shift - width, 0.66 + shift + width, L)
  const d = 1 - Math.abs(L - (0.575 + shift)) / (0.22 + 0.3 * blending)
  const wm = smoothstep(0, 1, d)
  return [ws, wm, wh]
}

/** Applies the grade to one sRGB-encoded colour (0..1). */
export function applyGrade(r, g, b, U) {
  const [L, A, B] = linearToOklab(dec(Math.max(0, r)), dec(Math.max(0, g)), dec(Math.max(0, b)))
  const [ws, wm, wh] = gradeWeights(L, U.blending, U.balance)
  const w = [ws, wm, wh, 1]
  const fade = smoothstep(0.05, 0.3, L) * (1 - 0.7 * smoothstep(0.93, 1, L)) // deep blacks / pure white stay clean (like LR)
  let a = A, bb = B, l = L
  for (let i = 0; i < 4; i++) {
    a += U.tints[i * 2] * w[i] * fade
    bb += U.tints[i * 2 + 1] * w[i] * fade
    l += U.lums[i] * w[i]
  }
  const lin = oklabToLinear(Math.max(0, l), a, bb)
  let [R, G, Bl] = lin
  // Gamut fit toward the pixel's luminance (same as the tone stage).
  const m = Math.max(R, G, Bl)
  if (m > 1) {
    const Y = lumaOf(R, G, Bl)
    if (Y >= 1) { R = G = Bl = 1 } else { const t = (1 - Y) / (m - Y); R = Y + (R - Y) * t; G = Y + (G - Y) * t; Bl = Y + (Bl - Y) * t }
  }
  return [enc(Math.max(0, R)), enc(Math.max(0, G)), enc(Math.max(0, Bl))]
}

// ---- Grain -----------------------------------------------------------------------------
// Film-like, monochrome, fixed to the IMAGE (not to screen pixels), so the preview and a
// full-size export show the same grain; deterministic (no flicker between renders); weaker in
// deep shadows and bright highlights. Integer hash → identical in JS and GLSL.
export const GRAIN_CELLS = 1300 // grain cells across the longer side of the photo

/** Amount 0–100 → peak amplitude (encoded 0..1). 25 ≈ subtle, 100 ≈ heavy (like LR). */
export const grainAmplitude = (amount) => Math.pow(Math.max(0, Math.min(100, amount)) / 100, 1.2) * 0.12

function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + 1013904223) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return (h & 0xffffff) / 16777215
}
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y)
  let fx = x - xi, fy = y - yi
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}
/** Grain offset for image position (u, v in 0..1) of an image with cellsX × cellsY cells. */
export function grainAt(u, v, cellsX, cellsY, amp, lumaEnc, rough = 0.5) {
  const x = u * cellsX, y = v * cellsY
  // Roughness: how much of the finer, irregular octave is mixed in (LR default 50 → 0.7 / 0.3).
  const n = (1 - 0.6 * rough) * (valueNoise(x, y) - 0.5) + 0.6 * rough * (valueNoise(x * 2.3 + 17.1, y * 2.3 + 5.3) - 0.5)
  const w = 0.3 + 0.7 * 4 * lumaEnc * (1 - lumaEnc)
  return n * 2 * amp * w
}
/** Grain Size 0–100 (LR default 25): each +25 doubles the grain size. */
export function grainCells(w, h, size = 25) {
  const m = Math.max(w, h)
  const n = GRAIN_CELLS * Math.pow(2, (25 - Math.max(0, Math.min(100, size))) / 25)
  return [n * (w / m), n * (h / m)]
}

// ---- Post-crop vignette --------------------------------------------------------------------
// Lightroom-style: Amount (− darker / + lighter corners), Midpoint (how far in it reaches),
// Roundness (−100 rounded rectangle … 0 ellipse fitting the frame … +100 circle), Feather
// (softness of the edge) and Highlights (keeps bright areas bright when darkening).
// Computed on the final (cropped) image, so it always follows the crop.
export function vignetteParams(s) {
  return {
    amount: Math.max(-100, Math.min(100, s.vignette || 0)) / 100,
    mid: (s.vignetteMidpoint ?? 50) / 100,
    round: (s.vignetteRoundness ?? 0) / 100,
    feather: (s.vignetteFeather ?? 50) / 100,
    highlights: (s.vignetteHighlights ?? 0) / 100,
  }
}

/** 0 (untouched centre) … 1 (full effect) for image position u, v (0..1) of a w × h image. */
export function vignetteWeight(u, v, w, h, P) {
  let x = (u - 0.5) * 2, y = (v - 0.5) * 2
  if (P.round > 0) {
    const m = Math.min(w, h)
    x *= 1 + ((w / m) - 1) * P.round
    y *= 1 + ((h / m) - 1) * P.round
  }
  const p = P.round < 0 ? 2 - P.round * 4 : 2
  const d = Math.pow(Math.pow(Math.abs(x), p) + Math.pow(Math.abs(y), p), 1 / p)
  const r = 0.45 + 0.95 * P.mid
  const fw = 0.05 + P.feather
  return smoothstep(r - fw / 2, r + fw / 2, d)
}

/** Applies the vignette to one encoded colour (0..1). */
export function applyVignette(r, g, b, wgt, P) {
  if (!wgt) return [r, g, b]
  if (P.amount < 0) {
    let k = -P.amount * wgt
    if (P.highlights) k *= 1 - 0.9 * P.highlights * smoothstep(0.5, 1, lumaOf(r, g, b))
    const f = 1 - 0.85 * k
    return [r * f, g * f, b * f]
  }
  const k = P.amount * wgt * 0.85
  return [r + (1 - r) * k, g + (1 - g) * k, b + (1 - b) * k]
}
