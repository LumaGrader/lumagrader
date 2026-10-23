// Small tone helpers shared by the renderers, masks and lens corrections. The Lightroom-matched
// slider models (Exposure, Contrast, Highlights, Shadows, Whites, Blacks) live in lrModel.js.

export const srgbDecode = (p) => (p <= 0.04045 ? p / 12.92 : Math.pow((p + 0.055) / 1.055, 2.4))
export const srgbEncode = (y) => (y <= 0.0031308 ? y * 12.92 : 1.055 * Math.pow(y, 1 / 2.4) - 0.055)

/** Linear luminance (Rec.709 / sRGB primaries). */
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** Scales linear RGB by `ratio`, fitting into gamut by desaturating toward luminance (keeps hue). */
export function applyRatioLinear(r, g, b, ratio) {
  let R = r * ratio, G = g * ratio, B = b * ratio
  const m = Math.max(R, G, B)
  if (m > 1) {
    const Y = luminance(R, G, B)
    if (Y >= 1) return [1, 1, 1]
    const t = (1 - Y) / (m - Y)
    R = Y + (R - Y) * t
    G = Y + (G - Y) * t
    B = Y + (B - Y) * t
  }
  return [Math.max(0, R), Math.max(0, G), Math.max(0, B)]
}
