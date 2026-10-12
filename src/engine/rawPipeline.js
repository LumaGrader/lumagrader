import { asShotFromLibRaw } from './color'
// Real RAW decoding: LibRaw (WebAssembly, public/libraw/) decodes the sensor data to
// linear 16-bit RGB, then workers/developWorker.js "develops" it into the 8-bit image the
// editor starts from (see rawDevelop.js). Everything runs off the main thread.
//
// Import uses a half-size decode (fast, ~1 s for 24 MP, plenty for the ≤1600px editing
// preview). Full-size is decoded only for export and 1:1 zoom, with the SAME develop params,
// so preview and export match. Any failure → caller falls back to the embedded JPEG preview.

const DECODE_SETTINGS = {
  outputBps: 16, // 16-bit output
  gamm: [1, 1], // linear (no gamma) — we do our own tone mapping
  noAutoBright: true, // keep real exposure; we match brightness ourselves
  useCameraWb: true, // "As Shot" white balance
  outputColor: 1, // sRGB primaries
  highlight: 0, // clip at sensor saturation (clean, no false colour)
  userQual: 3, // AHD demosaic (full size)
}
const IDLE_TERMINATE_MS = 30000

// ---- LibRaw worker client (same message protocol as libraw-wasm's own wrapper) -----------
let lr = null
let idleTimer = null

function librawWorker() {
  if (!lr) {
    const worker = new Worker(new URL('libraw/worker.js', document.baseURI), { type: 'module' })
    lr = { worker, pending: new Map(), nextId: 0, tail: Promise.resolve() }
    worker.onmessage = ({ data }) => {
      const p = lr?.pending.get(data?.id)
      if (!p) return
      lr.pending.delete(data.id)
      if (data.error) p.reject(new Error(data.error))
      else p.resolve(data.out)
    }
    worker.onerror = (e) => {
      const failed = lr
      lr = null
      failed?.pending.forEach((p) => p.reject(new Error(e.message || 'LibRaw worker failed')))
    }
  }
  clearTimeout(idleTimer)
  // WASM memory never shrinks — drop the worker when idle so a big decode doesn't linger.
  idleTimer = setTimeout(terminateLibRaw, IDLE_TERMINATE_MS)
  return lr
}

export function terminateLibRaw() {
  clearTimeout(idleTimer)
  if (!lr) return
  lr.worker.terminate()
  lr.pending.forEach((p) => p.reject(new Error('LibRaw stopped')))
  lr = null
}

function call(fn, ...args) {
  const c = librawWorker()
  const run = () =>
    new Promise((resolve, reject) => {
      const id = c.nextId++
      c.pending.set(id, { resolve, reject })
      const transfer = args.filter((a) => ArrayBuffer.isView(a)).map((a) => a.buffer)
      c.worker.postMessage({ id, fn, args }, transfer)
    })
  const p = c.tail.then(run, run) // LibRaw is stateful: one call at a time
  c.tail = p.then(() => {}, () => {})
  return p
}

// ---- develop worker client ------------------------------------------------------------
let dev = null
function developWorker() {
  if (!dev) {
    const worker = new Worker(new URL('../workers/developWorker.js', import.meta.url), { type: 'module' })
    dev = { worker, pending: new Map(), nextId: 0 }
    worker.onmessage = ({ data }) => {
      const p = dev?.pending.get(data.id)
      if (!p) return
      dev.pending.delete(data.id)
      if (data.ok) p.resolve(data)
      else p.reject(new Error(data.error))
    }
    worker.onerror = (e) => {
      const failed = dev
      dev = null
      failed?.pending.forEach((p) => p.reject(new Error(e.message || 'Develop worker failed')))
    }
  }
  return dev
}

function develop(data16, width, height, params, target) {
  const d = developWorker()
  return new Promise((resolve, reject) => {
    const id = d.nextId++
    d.pending.set(id, { resolve, reject })
    d.worker.postMessage({ id, data16, width, height, params, target }, [data16.buffer])
  })
}

// ---- helpers --------------------------------------------------------------------------

/** Camera-look target statistics from the embedded JPEG (decoded small). */
export async function targetStatsFromBlob(blob) {
  const { targetStatsFromRGBA } = await import('./rawDevelop')
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * scale))
  c.height = Math.max(1, Math.round(bmp.height * scale))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close?.()
  return { ...targetStatsFromRGBA(ctx.getImageData(0, 0, c.width, c.height).data), portrait: c.height > c.width }
}

/**
 * True when LibRaw has a colour matrix for this camera (built-in table or the DNG's own
 * ColorMatrix). Without one, cam_xyz stays all zero and LibRaw outputs uncorrected camera RGB,
 * so colours are noticeably off — newer cameras than the bundled LibRaw hit this.
 */
export function hasCameraColorMatrix(colorData) {
  const m = colorData?.cam_xyz
  if (!Array.isArray(m)) return false
  return m.slice(0, 3).some((row) => Array.isArray(row) && row.slice(0, 3).some((v) => Number.isFinite(v) && Math.abs(v) > 1e-6))
}

/** Rotates RGBA by 90° steps (safety net if the decoder didn't apply the RAW's orientation). */
function rotateRGBA(rgba, w, h, quarterTurnsCW) {
  const q = ((quarterTurnsCW % 4) + 4) % 4
  if (!q) return { rgba, w, h }
  const W = q % 2 ? h : w, H = q % 2 ? w : h
  const out = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = q === 1 ? h - 1 - y : q === 2 ? w - 1 - x : y
    const ny = q === 1 ? x : q === 2 ? h - 1 - y : w - 1 - x
    const s = (y * w + x) * 4, d = (ny * W + nx) * 4
    out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = 255
  }
  return { rgba: out, w: W, h: H }
}

/**
 * Decodes + develops a RAW file. Returns { imageData, params }.
 * @param {Blob} file         the RAW file
 * @param {object} opts
 *   half:   half-size decode (import) or full size (export / 1:1)
 *   params: develop params from a previous (half-size) develop — reuse for full size
 *   target: camera-look statistics (targetStatsFromBlob) — used when params is absent
 */
export async function decodeAndDevelopRaw(file, { half = true, params = null, target = null } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  await call('open', bytes, { ...DECODE_SETTINGS, halfSize: half })
  const meta = await call('metadata', true) // full: includes colour data (as-shot white balance)
  const img = await call('imageData')
  if (!img?.data || img.colors !== 3 || img.bits !== 16) throw new Error('Unexpected LibRaw output')
  if (!half) terminateLibRaw() // free the large WASM heap right after a full-size decode
  const data16 = img.data instanceof Uint16Array ? img.data : new Uint16Array(img.data.buffer ?? img.data)
  const res = await develop(data16, img.width, img.height, params, target)
  let { rgba, width: w, height: h } = res
  // Safety net: if our output's orientation disagrees with the upright camera preview,
  // rotate using the RAW's flip code (dcraw: 3 = 180°, 5 = 90° CCW, 6 = 90° CW).
  const flip = meta?.flip || 0
  const wantPortrait = target?.portrait ?? params?.portrait
  if (wantPortrait != null && wantPortrait !== h > w) {
    ;({ rgba, w, h } = rotateRGBA(rgba, w, h, flip === 5 ? 3 : 1))
  }
  const fitted = { ...res.params, portrait: h > w }
  let asShotWB = null
  try { asShotWB = asShotFromLibRaw(meta?.color_data) } catch { /* no Kelvin for this file */ }
  const colorUnknown = !hasCameraColorMatrix(meta?.color_data)
  const camera = [meta?.normalized_make || meta?.camera_make, meta?.normalized_model || meta?.camera_model].filter(Boolean).join(' ')
  return { imageData: new ImageData(rgba, w, h), params: fitted, asShotWB, colorUnknown, camera }
}

/** ImageData → Blob (PNG keeps the clean RAW pixels; no JPEG artifacts reintroduced). */
export function imageDataToBlob(imageData, type = 'image/png', quality) {
  const c = document.createElement('canvas')
  c.width = imageData.width
  c.height = imageData.height
  c.getContext('2d').putImageData(imageData, 0, 0)
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, quality))
}
