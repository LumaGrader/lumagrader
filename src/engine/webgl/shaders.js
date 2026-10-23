export const VERT_SRC = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`

// Single fragment shader implementing the full tonal/color/effects pipeline
// (everything except geometry, which is handled upstream on the CPU/Canvas 2D).
// Mirrors the math in engine/pipeline.js's Canvas 2D fallback as closely as possible.
export const FRAG_SRC = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_image;
uniform sampler2D u_curvePointsLUT;
uniform sampler3D u_cubeLut;
uniform bool u_useCubeLut;
uniform bool u_useCurvePoints;

// Lightroom-matched models — see lrModel.js.
uniform sampler2D u_localLUT;  // zone value → (Shadows gain, Highlights gain) in EV, 256 wide
uniform sampler2D u_globalLUT; // display value 0..1 → out: Exposure/Blacks/Whites/Contrast, 1024 wide
uniform sampler2D u_gfCoef;    // guided-filter (A, B): local base = A·log2(Y) + B — localBase.js
uniform sampler2D u_hslTable;  // Color Mixer: x = hue (°, 361 wide), y = Oklab chroma 0..0.3 (16 rows)
uniform bool u_useTone;        // global tone curve
uniform bool u_useLocal;       // Shadows / Highlights
uniform float u_exposureEV;
uniform float u_zoneMix;       // zone = mix · local base + (1 − mix) · pixel (EV)
uniform vec2 u_zoneChroma;     // chroma follows 2^(−β·gain): (Shadows β, Highlights β)
uniform vec2 u_zoneRange;      // zone table range: (min EV, span)
uniform float u_sat;      // Saturation −1..1 (color.js satVibFactor)
uniform bool u_useWB;
uniform mat3 u_wbMatrix;  // linear-sRGB white balance (color.js whiteBalanceMatrix)

uniform float u_curveStrength;

uniform float u_lutStrength;

uniform bool u_hslActive;
uniform float u_vibrance;


uniform bool u_gradeActive;   // Color Grading (color.js gradeUniforms)
uniform vec2 u_gradeTint[4];  // shadows, midtones, highlights, global — Oklab (a, b) offsets
uniform float u_gradeLum[4];
uniform float u_gradeBlend;
uniform float u_gradeBalance;

uniform float u_grain;      // peak amplitude (color.js grainAmplitude)
uniform vec2 u_grainCells;  // grain cells across the image (color.js grainCells)

uniform float u_vignette;     // amount −1..1 (color.js vignetteParams)
uniform vec4 u_vigParams;     // midpoint, roundness, feather, highlights (0..1 / −1..1)
uniform float u_grainRough;
uniform vec2 u_resolution;
uniform float u_dehaze;

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Global tone curve (lrModel.toneValue): 1024 texels over 0..1; above 1 it continues with the
// slope of the last step (RAW headroom).
float toneLut(float x) {
  if (x <= 1.0) return texture(u_globalLUT, vec2((max(x, 0.0) * 1023.0 + 0.5) / 1024.0, 0.5)).r;
  float y1 = texture(u_globalLUT, vec2(1023.5 / 1024.0, 0.5)).r;
  float y0 = texture(u_globalLUT, vec2(1022.5 / 1024.0, 0.5)).r;
  return y1 + (x - 1.0) * (y1 - y0) * 1023.0;
}

// Hue-preserving curve on ProPhoto RGB (sRGB-encoded) channels, like Lightroom: the curve
// moves the largest and smallest channel, the middle one keeps its relative position.
// (Matrices written column by column: GLSL mat3 is column-major.)
const mat3 SRGB_TO_PROPHOTO = mat3(0.5292804, 0.0983662, 0.0168753, 0.3301530, 0.8734640, 0.1176594, 0.1405666, 0.0281698, 0.8654652);
const mat3 PROPHOTO_TO_SRGB = mat3(2.0343675, -0.2288268, -0.0085584, -0.7276345, 1.2317534, -0.1532682, -0.3067331, -0.0029266, 1.1618266);
vec3 linearToSrgbOpen(vec3 c) { // like linearToSrgb, but keeps values above 1
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 toneRGB(vec3 lin) {
  vec3 e = linearToSrgbOpen(SRGB_TO_PROPHOTO * lin);
  float hi = max(max(e.r, e.g), e.b);
  float lo = min(min(e.r, e.g), e.b);
  float nhi = toneLut(hi);
  float nlo = toneLut(lo);
  vec3 o = hi - lo > 1e-6 ? nlo + (nhi - nlo) * (e - lo) / (hi - lo) : vec3(nhi);
  vec3 l = mix(o / 12.92, pow((max(o, 0.0) + 0.055) / 1.055, vec3(2.4)), step(0.04045, o));
  return clamp(PROPHOTO_TO_SRGB * l, 0.0, 1.0); // per-channel clip, like Lightroom's sRGB output
}

// ---- Color (mirrors engine/color.js) ----
float luma709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 fitGamut(vec3 lin) {
  float m = max(max(lin.r, lin.g), lin.b);
  if (m > 1.0) {
    float Y2 = luma709(lin);
    lin = Y2 >= 1.0 ? vec3(1.0) : Y2 + (lin - Y2) * ((1.0 - Y2) / (m - Y2));
  }
  return max(lin, 0.0);
}

float maxChromaScale(vec3 c, float L) {
  float k = 1e6;
  for (int i = 0; i < 3; i++) {
    float d = c[i] - L;
    if (d > 1e-6) k = min(k, (1.0 - L) / d);
    else if (d < -1e-6) k = min(k, L / -d);
  }
  return k;
}

// True luminance re-encoded (color.js greyOf) — what a colour becomes at zero saturation.
float greyOf(vec3 c) { return linearToSrgb(vec3(luma709(srgbToLinear(max(c, 0.0))))).r; }

vec3 scaleChroma(vec3 c, float k) {
  float L = greyOf(c);
  if (k > 1.0) k = min(k, max(1.0, maxChromaScale(c, L)));
  k = max(0.0, k);
  return L + (c - L) * k;
}

vec2 hueSat(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float ch = mx - mn;
  if (ch <= 1e-6) return vec2(0.0);
  float h;
  if (mx == c.r) h = mod((c.g - c.b) / ch, 6.0);
  else if (mx == c.g) h = (c.b - c.r) / ch + 2.0;
  else h = (c.r - c.g) / ch + 4.0;
  h *= 60.0;
  if (h < 0.0) h += 360.0;
  return vec2(h, mx > 0.0 ? ch / mx : 0.0);
}

float satVibFactor(vec3 c, float sat, float vib) {
  float k = 1.0 + sat;
  if (vib != 0.0) {
    vec2 hs = hueSat(c);
    if (vib > 0.0) {
      float dh = abs(hs.x - 28.0); if (dh > 180.0) dh = 360.0 - dh;
      float skin = max(0.0, 1.0 - dh / 30.0) * smoothstep(0.08, 0.3, hs.y);
      k *= 1.0 + vib * 1.3 * (1.0 - hs.y) * (1.0 - hs.y) * (1.0 - 0.55 * skin);
    } else {
      k *= 1.0 + vib * 0.85;
    }
  }
  return k;
}

vec3 linearToOklab(vec3 c) {
  vec3 lms = vec3(
    dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)),
    dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
    dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005)));
  lms = pow(max(lms, 0.0), vec3(1.0 / 3.0));
  return vec3(
    dot(lms, vec3(0.2104542553, 0.7936177850, -0.0040720468)),
    dot(lms, vec3(1.9779984951, -2.4285922050, 0.4505937099)),
    dot(lms, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
}
vec3 oklabToLinear(vec3 o) {
  vec3 lms = vec3(
    o.x + 0.3963377774 * o.y + 0.2158037573 * o.z,
    o.x - 0.1055613458 * o.y - 0.0638541728 * o.z,
    o.x - 0.0894841775 * o.y - 1.2914855480 * o.z);
  lms = lms * lms * lms;
  return vec3(
    dot(lms, vec3(4.0767416621, -3.3077115913, 0.2309699292)),
    dot(lms, vec3(-1.2684380046, 2.6097574011, -0.3413193965)),
    dot(lms, vec3(-0.0041960863, -0.7034186147, 1.7076147010)));
}

vec3 applyGrade(vec3 c) {
  vec3 o = linearToOklab(srgbToLinear(max(c, 0.0)));
  float L = o.x;
  float shift = -u_gradeBalance * 0.15;
  float width = 0.06 + 0.22 * u_gradeBlend;
  float ws = 1.0 - smoothstep(0.49 + shift - width, 0.49 + shift + width, L);
  float wh = smoothstep(0.66 + shift - width, 0.66 + shift + width, L);
  float wm = smoothstep(0.0, 1.0, 1.0 - abs(L - (0.575 + shift)) / (0.22 + 0.3 * u_gradeBlend));
  float fade = smoothstep(0.05, 0.3, L) * (1.0 - 0.7 * smoothstep(0.93, 1.0, L));
  vec4 w = vec4(ws, wm, wh, 1.0); // (no array constructors: Mali/ANGLE rejects them)
  for (int i = 0; i < 4; i++) {
    o.yz += u_gradeTint[i] * w[i] * fade;
    o.x += u_gradeLum[i] * w[i];
  }
  o.x = max(o.x, 0.0);
  return linearToSrgb(fitGamut(oklabToLinear(o)));
}

// Integer hash + value noise — bit-identical to color.js grainAt().
float hash2(ivec2 p) {
  uint h = uint(p.x) * 374761393u + uint(p.y) * 668265263u + 1013904223u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h & 0xffffffu) / 16777215.0;
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 q = ivec2(i);
  float a = hash2(q), b = hash2(q + ivec2(1, 0)), c = hash2(q + ivec2(0, 1)), d = hash2(q + ivec2(1, 1));
  return a + (b - a) * f.x + (c - a) * f.y + (a - b - c + d) * f.x * f.y;
}

void main() {
  vec3 c = texture(u_image, v_uv).rgb;

  // Tone — Lightroom-matched (lrModel.js; local base: localBase.js). Linear light: white
  // balance + Saturation/Calibration matrix, then Shadows/Highlights (gain by zone), then the
  // global curve (Exposure, Blacks, Whites, Contrast) hue-preserving on ProPhoto channels.
  if (u_useTone || u_useLocal || u_useWB) {
    vec3 lin = srgbToLinear(c);
    if (u_useWB) lin = max(u_wbMatrix * lin, 0.0);
    if (u_useLocal) {
      float Y0 = luma709(lin);
      if (Y0 > 1e-8) {
        float v0 = max(log2(Y0), -14.0);
        vec2 ab = texture(u_gfCoef, vec2(v_uv.x, 1.0 - v_uv.y)).rg; // map rows are top-down
        float base = clamp(ab.x * v0 + ab.y, -14.0, 6.0);
        float v = clamp(u_zoneMix * base + (1.0 - u_zoneMix) * v0, -14.0, 6.0) + u_exposureEV;
        float t = clamp((v - u_zoneRange.x) / u_zoneRange.y, 0.0, 1.0);
        vec2 g = texture(u_localLUT, vec2((t * 255.0 + 0.5) / 256.0, 0.5)).rg;
        lin *= exp2(g.x + g.y);
        // Keeps values above white; the gamut fit below handles them.
        vec3 cz = scaleChroma(linearToSrgbOpen(lin), exp2(-u_zoneChroma.x * g.x - u_zoneChroma.y * g.y));
        cz = max(cz, 0.0);
        lin = mix(cz / 12.92, pow((cz + 0.055) / 1.055, vec3(2.4)), step(0.04045, cz));
      }
    }
    if (u_useTone) lin = toneRGB(lin);
    c = linearToSrgb(fitGamut(lin));
  }
  // Saturation + Vibrance: chroma around luma, capped at the gamut edge.
  if (u_sat != 0.0 || u_vibrance != 0.0) c = scaleChroma(c, satVibFactor(c, u_sat, u_vibrance));
  c = clamp(c, 0.0, 1.0);

  // Dehaze approximation: not a true dark-channel-prior haze removal — just extra
  // contrast + saturation to punch through a hazy/flat look, paired with a large-radius
  // local-contrast pass later in the effect chain.
  // Dehaze: the haze removal itself is the dark-channel pass (renderer, combine mode 4);
  // here only the colour lift Lightroom's Dehaze also gives.
  if (u_dehaze > 0.0) c = scaleChroma(c, 1.0 + u_dehaze * 0.25);

  if (u_curveStrength != 0.0) {
    float gamma = 1.0 - u_curveStrength / 220.0;
    vec3 x = c;
    vec3 lo = 0.5 * pow(2.0 * x, vec3(gamma));
    vec3 hi = 1.0 - 0.5 * pow(2.0 * (1.0 - x), vec3(gamma));
    c = clamp(mix(lo, hi, step(0.5, x)), 0.0, 1.0);
  }

  if (u_useCurvePoints) {
    // 256-texel LUT: map 0..1 onto texel centers so linear filtering interpolates exactly.
    vec3 cu = (clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
    c.r = texture(u_curvePointsLUT, vec2(cu.r, 0.5)).r;
    c.g = texture(u_curvePointsLUT, vec2(cu.g, 0.5)).g;
    c.b = texture(u_curvePointsLUT, vec2(cu.b, 0.5)).b;
  }

  if (u_useCubeLut) {
    vec3 graded = texture(u_cubeLut, c).rgb;
    c = mix(c, graded, u_lutStrength);
  }

  // Color Mixer (lrModel.buildHSLTable): Oklab hue shift, chroma and lightness ratios looked up
  // by the pixel's hue and chroma.
  if (u_hslActive) {
    vec3 o = linearToOklab(srgbToLinear(max(c, 0.0)));
    float cc = length(o.yz);
    if (cc > 1e-5) {
      float hd = atan(o.z, o.y) * 57.29577951;
      if (hd < 0.0) hd += 360.0;
      float y = (clamp(cc / 0.3, 0.0, 1.0) * 15.0 + 0.5) / 16.0;
      vec3 e = texture(u_hslTable, vec2((hd + 0.5) / 361.0, y)).rgb;
      float hr = (hd + e.x) * 0.01745329252;
      float c2 = cc * exp(e.y);
      o = vec3(o.x * exp(e.z), cos(hr) * c2, sin(hr) * c2);
      c = linearToSrgb(fitGamut(max(oklabToLinear(o), 0.0)));
    }
  }

  if (u_gradeActive) c = applyGrade(c);

  if (u_grain > 0.0) {
    // Image position (top-down rows, like the Canvas fallback) → same grain in preview and export.
    vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_grainCells;
    float n = (1.0 - 0.6 * u_grainRough) * (valueNoise(p) - 0.5) + 0.6 * u_grainRough * (valueNoise(p * 2.3 + vec2(17.1, 5.3)) - 0.5);
    float le = clamp(luma709(c), 0.0, 1.0);
    n *= 2.0 * u_grain * (0.3 + 0.7 * 4.0 * le * (1.0 - le));
    c += n;
  }

  if (u_vignette != 0.0) { // Lightroom post-crop vignette — mirrors color.js vignetteWeight/applyVignette
    vec2 q = (vec2(v_uv.x, 1.0 - v_uv.y) - 0.5) * 2.0;
    float rnd = u_vigParams.y;
    if (rnd > 0.0) {
      float m = min(u_resolution.x, u_resolution.y);
      q *= 1.0 + (u_resolution / m - 1.0) * rnd;
    }
    float pw = rnd < 0.0 ? 2.0 - rnd * 4.0 : 2.0;
    float d = pow(pow(abs(q.x), pw) + pow(abs(q.y), pw), 1.0 / pw);
    float r = 0.45 + 0.95 * u_vigParams.x;
    float fw = 0.05 + u_vigParams.z;
    float wgt = smoothstep(r - fw * 0.5, r + fw * 0.5, d);
    if (u_vignette < 0.0) {
      float k = -u_vignette * wgt;
      k *= 1.0 - 0.9 * u_vigParams.w * smoothstep(0.5, 1.0, luma709(c));
      c *= 1.0 - 0.85 * k;
    } else {
      c = mix(c, vec3(1.0), u_vignette * wgt * 0.85);
    }
  }

  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

// Applies one local adjustment mask (linear or circular-radial gradient) to `u_image`.
// Chained per-mask, same ping-pong pattern as the blur/combine detail-effect passes.
export const MASK_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform int u_maskType; // 0 = linear, 1 = radial, 2 = brush, 3 = whole photo (luminance / color masks)
uniform int u_rangeType; // 0 = none, 1 = luminance range, 2 = color range, 3 = nothing selected
uniform vec4 u_rangeParams; // luminance: min, max, smoothness (0–1)  ·  color: tolerance, softness
uniform vec3 u_rangeColor; // color range: picked colour in Oklab
uniform bool u_showOverlay; // preview only: tint the selected mask red
uniform vec4 u_linear;  // x1,y1,x2,y2 (UV space)
uniform vec4 u_radial;  // cx,cy,rx,ry (normalized to the shorter image edge)
uniform sampler2D u_brushMask;
uniform sampler2D u_blurredForSharpen;
uniform bool u_useDetailBlur;
uniform float u_sharpen;
uniform float u_denoise;
uniform float u_feather; // 0..1 — 0 = hard edge, 1 = the original full-length soft gradient
uniform float u_amount;  // 0..1 — overall strength of the mask (Amount)
uniform bool u_invert;
uniform float u_exposure;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temp;
uniform vec2 u_resolution;

// Feathered edges use smoothstep (an S-curve), not a straight ramp: a straight ramp has
// visible "corners" where the transition starts and ends (a cone tip in the middle of a fully
// feathered radial mask, hard-looking edges on gradients). At Feather 0 the edge is still
// ~1.5 px soft (fwidth) so it isn't jagged.
float linearWeight(vec2 uv) {
  vec2 p1 = u_linear.xy;
  vec2 p2 = u_linear.zw;
  vec2 dir = p2 - p1;
  float len = length(dir);
  if (len < 0.0001) return 0.0;
  float t = dot(uv - p1, dir) / (len * len);
  float halfWidth = max(u_feather * 0.5, 0.75 * fwidth(t));
  return smoothstep(0.5 - halfWidth, 0.5 + halfWidth, t);
}

float radialWeight(vec2 uv) {
  vec2 pixelPos = (uv - u_radial.xy) * u_resolution;
  float minDim = min(u_resolution.x, u_resolution.y);
  float rx = max(u_radial.z * minDim, 0.001);
  float ry = max(u_radial.w * minDim, 0.001);
  float dist = length(vec2(pixelPos.x / rx, pixelPos.y / ry)); // 1.0 = exactly on the ellipse
  float innerDist = 1.0 - u_feather; // full effect inside this, fading out to the ellipse
  float aa = 1.5 * fwidth(dist);
  return 1.0 - smoothstep(min(innerDist, 1.0 - aa), 1.0, dist);
}

float srgbToLin(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
vec3 toOklab(vec3 c) {
  vec3 l = vec3(srgbToLin(c.r), srgbToLin(c.g), srgbToLin(c.b));
  vec3 lms = vec3(
    0.4122214708 * l.r + 0.5363325363 * l.g + 0.0514459929 * l.b,
    0.2119034982 * l.r + 0.6806995451 * l.g + 0.1073969566 * l.b,
    0.0883024619 * l.r + 0.2817188376 * l.g + 0.6299787005 * l.b);
  lms = pow(max(lms, vec3(0.0)), vec3(1.0 / 3.0));
  return vec3(
    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);
}

// Range masks (like Lightroom's Luminance / Color Range): select by the pixel's brightness
// (0–1, perceptual) or by closeness to a picked colour (Oklab; hue/chroma count most).
float rangeWeight(vec3 c) {
  if (u_rangeType == 1) {
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float s = 0.005 + u_rangeParams.z * 0.25;
    return smoothstep(u_rangeParams.x - s, u_rangeParams.x, y) * (1.0 - smoothstep(u_rangeParams.y, u_rangeParams.y + s, y));
  }
  if (u_rangeType == 2) {
    vec3 lab = toOklab(c);
    float d = length(lab.yz - u_rangeColor.yz) + 0.35 * abs(lab.x - u_rangeColor.x);
    float tol = u_rangeParams.x;
    return 1.0 - smoothstep(tol * (1.0 - u_rangeParams.y), tol, d);
  }
  if (u_rangeType == 3) return 0.0; // colour not picked yet
  return 1.0;
}

void main() {
  vec3 base = texture(u_image, v_uv).rgb;
  // Mask geometry is captured in DOM space (Y=0 at top), but WebGL's v_uv has Y=0 at the
  // bottom — flip just for the mask math so the applied effect lines up with the guide the
  // user actually drew. Horizontal drags hide this mismatch by coincidence; diagonal ones
  // show it clearly, which is why only diagonal masks looked mirrored.
  vec2 maskUv = vec2(v_uv.x, 1.0 - v_uv.y);
  float w;
  if (u_maskType == 0) w = linearWeight(maskUv);
  else if (u_maskType == 1) w = radialWeight(maskUv);
  else if (u_maskType == 2) w = texture(u_brushMask, v_uv).a; // painted with the same upload flip as the main image — no manual flip needed
  else w = 1.0;
  float range = rangeWeight(base);
  if (u_maskType == 3) w = u_invert ? 1.0 - range : range; // range-only mask: invert the range
  else w = (u_invert ? 1.0 - w : w) * range; // shape masks: the range refines the (inverted) shape
  w *= u_amount;

  vec3 c = base * (1.0 + u_exposure);
  c = (c - 0.5) * (1.0 + u_contrast) + 0.5;
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, 1.0 + u_saturation);
  c.r += u_temp * 0.12;
  c.b -= u_temp * 0.12;
  if (u_useDetailBlur) {
    vec3 blurred = texture(u_blurredForSharpen, v_uv).rgb;
    if (u_sharpen != 0.0) c = c + u_sharpen * (c - blurred); // negative = soften
    if (u_denoise > 0.0) c = mix(c, blurred, u_denoise);
  }
  c = clamp(c, 0.0, 1.0);

  vec3 result = mix(base, c, w);
  if (u_showOverlay) result = mix(result, vec3(1.0, 0.1, 0.1), w * 0.55);
  outColor = vec4(result, 1.0);
}`

// Handles Sharpen (mode 0, with edge-detected Masking), Luminance Noise Reduction
// (mode 1, smooths brightness only, keeps chroma), and Color Noise Reduction (mode 2,
// smooths chroma only, keeps luminance) — each reusing the same blur input, just combined
// differently. "Detail" in modes 1/2 is edge-preservation: less smoothing where the local
// blur difference (a proxy for edge strength) is already large.
export const DETAIL_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_original;
uniform sampler2D u_blurred;
uniform int u_mode;
uniform float u_amount;
uniform float u_detail;
uniform float u_masking;
uniform float u_contrast;

void main() {
  vec3 orig = texture(u_original, v_uv).rgb;
  vec3 blur = texture(u_blurred, v_uv).rgb;
  vec3 diff = orig - blur;
  float edge = length(diff);

  if (u_mode == 0) {
    float m = u_masking > 0.0 ? smoothstep(u_masking * 0.4, u_masking * 0.4 + 0.15, edge) : 1.0;
    outColor = vec4(clamp(orig + u_amount * m * diff, 0.0, 1.0), 1.0);
    return;
  }

  float luma = dot(orig, vec3(0.2126, 0.7152, 0.0722));
  float lumaBlur = dot(blur, vec3(0.2126, 0.7152, 0.0722));
  float edgePreserve = 1.0 - u_detail * clamp(edge * 4.0, 0.0, 1.0);

  if (u_mode == 1) {
    float newLuma = mix(luma, lumaBlur, u_amount * edgePreserve);
    vec3 result = orig + (newLuma - luma) + u_contrast * 0.3 * diff;
    outColor = vec4(clamp(result, 0.0, 1.0), 1.0);
    return;
  }

  vec3 chroma = orig - vec3(luma);
  vec3 chromaBlur = blur - vec3(lumaBlur);
  vec3 newChroma = mix(chroma, chromaBlur, u_amount * edgePreserve);
  outColor = vec4(clamp(vec3(luma) + newChroma, 0.0, 1.0), 1.0);
}`

// Sample spacing is scaled by u_radius so a fixed tap count still gives a variable blur size.
export const BLUR_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_image;
uniform vec2 u_direction;
uniform vec2 u_texel;
uniform float u_radius;

// Gaussian weights (no float[5] constructor: Mali/ANGLE rejects array constructors).
float blurWeight(int i) {
  if (i == 0) return 0.227027;
  if (i == 1) return 0.1945946;
  if (i == 2) return 0.1216216;
  if (i == 3) return 0.054054;
  return 0.016216;
}

void main() {
  vec3 result = texture(u_image, v_uv).rgb * blurWeight(0);
  for (int i = 1; i < 5; i++) {
    vec2 offset = u_direction * u_texel * float(i) * u_radius;
    result += texture(u_image, v_uv + offset).rgb * blurWeight(i);
    result += texture(u_image, v_uv - offset).rgb * blurWeight(i);
  }
  outColor = vec4(result, 1.0);
}`

// Combines an original image with its blurred version: mode 0 = unsharp-mask sharpening
// (push away from the blur), mode 1 = noise reduction (blend toward the blur).
export const COMBINE_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_original;
uniform sampler2D u_blurred;
uniform float u_amount;
uniform int u_mode;

// Modes: 0 unsharp (push from blur), 1 blend toward blur,
//        2 Clarity — luminance-only local contrast, strongest in the midtones, halo-limited,
//        3 Texture — luminance-only fine detail, halo-limited,
//        4 Dehaze — dark-channel haze estimate from the large-scale blur; negative adds haze.
// Luminance-only: the same offset is added to R, G and B, so colours don't shift.
float lumaC(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec3 orig = texture(u_original, v_uv).rgb;
  vec3 blur = texture(u_blurred, v_uv).rgb;
  vec3 result;
  if (u_mode == 0) result = orig + u_amount * (orig - blur);
  else if (u_mode == 1) result = mix(orig, blur, u_amount);
  else if (u_mode == 2 || u_mode == 3) {
    float lo = lumaC(orig);
    float d = lo - lumaC(blur);
    float w = 1.0;
    if (u_mode == 2) {
      d = clamp(d, -0.12, 0.12);
      w = mix(0.2, 1.0, clamp(4.0 * lo * (1.0 - lo), 0.0, 1.0)); // protect deep shadows / highlights
    } else {
      // Texture works on fine, low-contrast detail (skin, foliage, surfaces) — strong edges
      // are left to Sharpening / Clarity, like Lightroom's Texture.
      d *= 1.0 - smoothstep(0.04, 0.14, abs(d));
    }
    result = orig + u_amount * d * w;
  } else {
    float haze = min(min(blur.r, blur.g), blur.b);
    float A = 0.95;
    float t = max(1.0 - u_amount * 0.9 * haze, 0.3);
    result = (orig - A) / t + A;
  }
  outColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}`
