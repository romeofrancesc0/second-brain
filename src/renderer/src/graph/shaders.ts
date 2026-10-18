// GLSL for the network. Look: dark, cinematic and quiet.
//  - neurons: lit glass-like spheres with per-neuron variation, a soft inner core and a shallow depth of field
//  - synapses: thin, slightly curved, desaturated threads
//  - clusters: volumetric haze tinted with the colour of the region
//  - sky: a very low-contrast nebula, dust and soft bokeh for depth; film grain and vignette at the end

const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
`

/* ------------------------------------------------------------------ neurons */

const neuronCommonVertex = /* glsl */ `
attribute vec3 aPos;
attribute vec3 aColor;
attribute float aSize;
attribute float aState;   // 0 idle, 1 highlighted neighbour, 2 selected, 3 hovered
attribute float aVisible;
attribute float aSeed;
attribute float aKind;    // 0 note, 1 MOC, 2 attachment, 3 unresolved

uniform float uScale;
uniform float uPixelScale;
uniform float uDim;
uniform float uFogNear;
uniform float uFogFar;
uniform float uQuad;      // quad half-size, in soma radii
uniform float uFocus;     // focus distance (camera -> orbit target)
uniform float uDof;       // depth of field strength

varying vec2 vUv;
varying vec3 vColor;
varying float vPx;
varying float vState;
varying float vKind;
varying float vFog;
varying float vDim;
varying float vSeed;
varying float vBlur;

void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  float depth = max(-mv.z, 0.001);
  float boost = aState > 2.5 ? 1.1 : (aState > 1.5 ? 1.2 : 1.0);
  float radius = aSize * uScale * boost;
  float rpx = radius / (depth * uPixelScale);
  // shallow depth of field: neurons away from the focus plane go soft; the selected one stays sharp
  float blur = aState > 1.5 && aState < 2.5 ? 0.0 : clamp(abs(depth - uFocus) / (uFocus + 60.0) * 1.15, 0.0, 1.0) * uDof;
  float grow = max(1.0, 1.4 / max(rpx, 1e-4));   // distant neurons stay ~1.4px dots
  float q = uQuad * (1.0 + blur * 0.55);
  mv.xy += position.xy * radius * grow * q;
  gl_Position = projectionMatrix * mv;

  vUv = position.xy * q;
  vPx = rpx * grow;
  vColor = aColor;
  vState = aState;
  vKind = aKind;
  vSeed = aSeed;
  vBlur = blur;
  vFog = smoothstep(uFogNear, uFogFar, depth);
  vDim = aState > 0.5 ? 0.0 : uDim;
  if (aVisible < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`

export const neuronVertex = neuronCommonVertex
export const haloVertex = neuronCommonVertex

export const neuronFragment = /* glsl */ `
uniform vec3 uBg;
uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vPx;
varying float vState;
varying float vKind;
varying float vFog;
varying float vDim;
varying float vSeed;
varying float vBlur;
${NOISE}

vec3 tint(vec3 c, float seed) {
  // every neuron is a little different: lightness and a hint of hue, so a cluster reads as living tissue
  float l = 0.86 + 0.28 * fract(seed * 7.13);
  vec3 warm = vec3(1.06, 1.0, 0.92);
  vec3 cool = vec3(0.92, 1.0, 1.08);
  return c * l * mix(warm, cool, fract(seed * 3.71));
}

void main() {
  vec2 p = vUv;
  float r = length(p);
  bool isAttachment = vKind > 1.5 && vKind < 2.5;
  bool isUnresolved = vKind > 2.5;

  float shapeR = isAttachment ? max(abs(p.x), abs(p.y)) * 1.12 : r;
  float soft = max(vBlur * 0.9, 0.0);
  float aa = max(fwidth(shapeR), 0.004) * 1.2 + soft * 0.5;
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, shapeR);
  if (isUnresolved) alpha *= smoothstep(0.62 - aa, 0.62, r);
  alpha *= 1.0 - vBlur * 0.35;
  if (alpha <= 0.001) discard;

  float z = sqrt(max(0.0, 1.0 - min(r * r, 1.0)));
  vec3 n = normalize(vec3(p, z));
  vec3 L = normalize(vec3(-0.45, 0.6, 0.66));
  float lambert = max(dot(n, L), 0.0);
  float wrap = max(dot(n, L) * 0.5 + 0.5, 0.0);
  float fres = pow(1.0 - z, 2.4);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 38.0);

  vec3 base = tint(vColor, vSeed);
  float detail = smoothstep(14.0, 60.0, vPx) * (1.0 - vBlur);

  // glass body: dark centre, bright rim, light scattering through the sphere
  vec3 col = base * (0.14 + 0.52 * wrap * wrap);
  col += mix(base, vec3(1.0), 0.25) * 0.7 * fres * (0.5 + 0.5 * lambert);   // rim light
  vec3 inner = base * pow(z, 1.3) * 0.28;                        // transmitted light
  // soft nucleus, offset a little differently for each neuron
  vec2 nc = p - vec2(0.18, 0.1) * (fract(vSeed * 5.3) - 0.5) * 2.0;
  float nucleus = exp(-dot(nc, nc) * 9.0);
  inner += mix(base, vec3(1.0), 0.45) * nucleus * 0.38;
  // fine cytoplasm texture, only visible up close
  float tex = fbm(p * 5.0 + vSeed * 40.0 + uTime * 0.02);
  inner *= 1.0 + (tex - 0.5) * 0.55 * detail;
  col += inner;
  col += vec3(1.0) * spec * 0.5 * (1.0 - vBlur);                 // wet highlight
  // thin membrane line
  col += mix(base, vec3(1.0), 0.35) * smoothstep(0.93, 0.995, r) * (1.0 - smoothstep(0.995, 1.0, r)) * 0.35 * detail;

  if (isAttachment) col = mix(base, vec3(0.72, 0.74, 0.8), 0.6) * (0.22 + 0.55 * wrap) + vec3(spec * 0.15);
  if (isUnresolved) col = base * 0.45;
  if (vState > 2.5) col *= 1.18;
  if (vState > 1.5 && vState < 2.5) col = mix(col, vec3(1.0), 0.1) * 1.12;

  float far = 1.0 - smoothstep(0.8, 2.5, vPx);
  float lens = vState > 1.5 && vState < 2.5 ? 0.0 : smoothstep(150.0, 420.0, vPx);
  alpha *= 1.0 - lens;
  if (alpha <= 0.001) discard;
  float toBg = clamp(vFog * 0.82 + vDim * 0.86 + far * 0.2 + lens * 0.6, 0.0, 0.95);
  gl_FragColor = vec4(mix(col, uBg, toBg), alpha);
}
`

/** Outer glow plus selection / hub rings, drawn additively around the solid soma. */
export const haloFragment = /* glsl */ `
uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vPx;
varying float vState;
varying float vKind;
varying float vFog;
varying float vDim;
varying float vSeed;
varying float vBlur;

void main() {
  float r = length(vUv);
  if (r < 0.98) discard;
  bool isMoc = vKind > 0.5 && vKind < 1.5;
  float glow = exp(-(r - 1.0) * 2.6) * (0.07 + 0.05 * vBlur);
  float ring = 0.0;
  if (isMoc) {
    ring += exp(-pow((r - 1.45) * 20.0, 2.0)) * 0.3;
    ring += exp(-pow((r - 1.9) * 26.0, 2.0)) * 0.12 * (0.6 + 0.4 * sin(uTime * 0.5 + vSeed * 6.0));
    glow += exp(-(r - 1.0) * 1.8) * 0.06;
  }
  if (vState > 1.5 && vState < 2.5) {
    ring += exp(-pow((r - 1.35) * 16.0, 2.0)) * 0.85;
    glow += exp(-(r - 1.0) * 2.2) * 0.17;
  } else if (vState > 2.5) {
    ring += exp(-pow((r - 1.3) * 18.0, 2.0)) * 0.5;
  }
  ring *= smoothstep(3.0, 7.0, vPx) * (1.0 - vBlur);
  float k = (glow + ring) * (1.0 - vFog * 0.85) * (1.0 - vDim * 0.9);
  if (k < 0.002) discard;
  gl_FragColor = vec4(mix(vColor, vec3(1.0), 0.25) * k, 1.0);
}
`

/* ----------------------------------------------------------------- synapses */

export const synapseVertex = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute float aSide;
attribute float aT;
attribute vec3 aColor;
attribute float aState;
attribute float aSeed;
attribute float aVisible;

uniform float uPixelScale;
uniform float uWidth;
uniform float uOpacity;
uniform float uDim;
uniform float uFogNear;
uniform float uFogFar;
uniform float uHlGain;
uniform float uCurve;

varying float vSide;
varying float vT;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;
varying float vState;

void main() {
  vec3 a = (modelViewMatrix * vec4(aStart, 1.0)).xyz;
  vec3 b = (modelViewMatrix * vec4(aEnd, 1.0)).xyz;
  const float zc = -0.6;
  if ((a.z > zc && b.z > zc) || aVisible < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // gentle arc: push the middle of the thread sideways (in view space), a different way for each link
  vec3 chord = b - a;
  vec3 side = normalize(cross(chord, vec3(sin(aSeed * 40.0), cos(aSeed * 23.0), 0.5)) + vec3(1e-5));
  float bulge = (aSeed - 0.5) * 0.24 * length(chord) * uCurve;
  vec3 mid = (a + b) * 0.5 + side * bulge;
  // quadratic Bezier through a, mid and b
  vec3 ctrl = 2.0 * mid - 0.5 * (a + b);

  vec3 a0 = a;
  vec3 b0 = b;
  if (a.z > zc) a = mix(a, b, (a.z - zc) / (a.z - b.z));
  if (b.z > zc) b = mix(b, a0, (b.z - zc) / (b.z - a0.z));
  float tt = aT;
  // map the clipped part of the segment back onto the full curve
  float tA = a == a0 ? 0.0 : clamp((a0.z - zc) / max(a0.z - b0.z, 1e-4), 0.0, 1.0);
  float tB = b == b0 ? 1.0 : clamp(1.0 - (b0.z - zc) / max(b0.z - a0.z, 1e-4), 0.0, 1.0);
  tt = mix(tA, tB, aT);
  vec3 p = (1.0 - tt) * (1.0 - tt) * a0 + 2.0 * (1.0 - tt) * tt * ctrl + tt * tt * b0;
  // tangent of the curve for the ribbon width
  vec3 tan = 2.0 * (1.0 - tt) * (ctrl - a0) + 2.0 * tt * (b0 - ctrl);
  vec3 p2 = p + tan * 0.01;
  vec2 sp = p.xy / max(-p.z, 0.01);
  vec2 sp2 = p2.xy / max(-p2.z, 0.01);
  vec2 d = sp2 - sp;
  float dl = length(d);
  vec2 dir = dl > 1e-9 ? d / dl : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);

  float depth = max(-p.z, 0.01);
  float hl = aState > 0.5 ? 1.0 : 0.0;
  float w = uWidth * (1.0 + hl * 0.5);
  float px = depth * uPixelScale;
  float ww = clamp(w, 0.55 * px, (hl > 0.5 ? 1.6 : 1.1) * px);
  p.xy += perp * aSide * ww;
  gl_Position = projectionMatrix * vec4(p, 1.0);

  vSide = aSide;
  vT = tt;
  vSeed = aSeed;
  vState = aState;
  vec3 grey = vec3(dot(aColor, vec3(0.3, 0.5, 0.2)));
  vColor = hl > 0.5 ? mix(aColor, vec3(1.0), 0.15) : mix(aColor, grey, 0.4);

  float thin = pow(min(w / ww, 1.0), 0.5);
  float fog = 1.0 - smoothstep(uFogNear, uFogFar, depth) * 0.85;
  float dim = mix(1.0, hl > 0.5 ? 1.0 : 0.08, uDim);
  vAlpha = uOpacity * fog * dim * thin * (hl > 0.5 ? 0.85 * uHlGain + 0.15 : 0.22);
}
`

export const synapseFragment = /* glsl */ `
uniform float uTime;
uniform float uPulses;

varying float vSide;
varying float vT;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;
varying float vState;

void main() {
  float core = exp(-vSide * vSide * 3.5);
  float hl = vState > 0.5 ? 1.0 : 0.0;
  float speed = hl > 0.5 ? 0.35 : 0.08;
  float ph = fract(vT - uTime * speed - vSeed);
  float pulse = pow(1.0 - ph, 30.0) * uPulses * (0.35 + hl * 0.65);
  // threads fade out towards both ends, as if they dissolved into the neurons
  float ends = smoothstep(0.0, 0.08, vT) * smoothstep(1.0, 0.92, vT);
  gl_FragColor = vec4(vColor * core * (1.0 + pulse * 1.5), vAlpha * mix(0.55, 1.0, ends));
}
`

/* --------------------------------------------------- cluster haze (volumetric) */

export const hazeVertex = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 aColor;
attribute float aRadius;
attribute float aSeed;

uniform float uHaze;
uniform float uPixelScale;
uniform float uCamDist;

varying vec2 vUv;
varying vec3 vColor;
varying float vSeed;
varying float vAlpha;

void main() {
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  float depth = max(-mv.z, 0.001);
  mv.xy += position.xy * aRadius;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy;
  vColor = aColor;
  vSeed = aSeed;
  // when the camera is inside a cloud it must not wash out the view
  float inside = smoothstep(aRadius * 0.35, aRadius * 1.6, depth);
  // far, tiny clouds fade so distant clusters don't turn into a flat fog
  vAlpha = uHaze * inside * (mv.z < 0.0 ? 1.0 : 0.0);
}
`

export const hazeFragment = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vSeed;
varying float vAlpha;
${NOISE}

void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  vec2 q = vUv * 1.7 + vSeed * 31.0;
  float n = fbm(q + vec2(uTime * 0.006, -uTime * 0.004));
  float n2 = fbm(q * 2.3 - 7.0);
  float shape = smoothstep(1.0, 0.0, r);
  shape = shape * shape;
  float cloud = shape * (0.35 + 0.9 * n) * (0.7 + 0.6 * n2);
  vec3 col = vColor * cloud * 0.09;
  // slightly brighter, warmer wisps in the densest parts
  col += mix(vColor, vec3(1.0), 0.4) * pow(cloud, 2.2) * 0.12;
  gl_FragColor = vec4(col * vAlpha, 1.0);
}
`

/* -------------------------------------------------------- dust, bokeh and sky */

export const dustVertex = /* glsl */ `
attribute float aSeed;
uniform float uPixelRatio;
uniform float uFocus;
uniform float uTime;
uniform float uDust;
varying float vBlur;
varying float vA;
varying float vSeed;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 1.0);
  float blur = clamp(abs(depth - uFocus) / (uFocus + 200.0) * 1.3, 0.0, 1.0);
  float size = (60.0 + aSeed * 90.0) / depth;
  gl_PointSize = clamp((size + blur * 14.0 * aSeed * aSeed) * uPixelRatio, 1.0, 26.0 * uPixelRatio);
  gl_Position = projectionMatrix * mv;
  vBlur = blur;
  vSeed = aSeed;
  vA = uDust * (0.5 + 0.5 * sin(uTime * (0.2 + aSeed * 0.5) + aSeed * 60.0)) * (mv.z < 0.0 ? 1.0 : 0.0);
}
`

export const dustFragment = /* glsl */ `
varying float vBlur;
varying float vA;
varying float vSeed;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  // sharp specks when in focus, soft discs with a faint rim (bokeh) when out of focus
  float sharp = exp(-d * d * 7.0);
  float disc = (1.0 - smoothstep(0.7, 1.0, d)) * (0.55 + 0.45 * smoothstep(0.5, 0.95, d));
  float k = mix(sharp, disc * 0.35, vBlur);
  vec3 tint = mix(vec3(0.62, 0.70, 0.9), vec3(0.95, 0.82, 0.7), fract(vSeed * 9.0));
  gl_FragColor = vec4(tint * k * vA * 0.5, 1.0);
}
`

export const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const skyFragment = /* glsl */ `
uniform vec3 uBg;
uniform float uAtmos;
varying vec3 vDir;
${NOISE}
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col = mix(uBg * 0.65, uBg * 1.4, 0.5 + 0.5 * y);
  vec2 uv = d.xz / (abs(d.y) + 0.9) * 1.4 + d.y * vec2(0.9, -0.6);
  float a = fbm(uv * 1.6 + 3.0);
  float b = fbm(uv * 3.1 - 9.0);
  float band = smoothstep(0.42, 0.8, a) * (0.5 + 0.5 * b);
  // two very dim tints (cool teal, warm violet): enough to give the dark some depth
  vec3 tealC = vec3(0.020, 0.075, 0.095);
  vec3 violetC = vec3(0.075, 0.032, 0.095);
  col += (tealC * band + violetC * smoothstep(0.5, 0.9, b) * (1.0 - band * 0.5)) * uAtmos * 0.75;
  col += vec3(0.02, 0.025, 0.04) * smoothstep(0.35, 0.0, abs(y)) * uAtmos;   // faint horizon glow
  gl_FragColor = vec4(col, 1.0);
}
`

/* ------------------------------------------------------------ film pass */

export const filmShader = {
  uniforms: {
    tDiffuse: { value: null as unknown },
    uTime: { value: 0 },
    uGrain: { value: 0.03 },
    uVignette: { value: 0.35 },
    uAspect: { value: 1.6 },
    uHeight: { value: 900 },
    /** Hologram: scanlines and the occasional glitched band (0 = off). */
    uScan: { value: 0 },
    /** Strength of the chromatic fringing towards the edges. */
    uAberr: { value: 1 }
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uAspect;
    uniform float uHeight;
    uniform float uScan;
    uniform float uAberr;
    varying vec2 vUv;
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec2 uv = vUv;
      // hologram: now and then a thin band of the image slips sideways
      float band = step(0.992, hash(vec2(floor(uTime * 7.0), floor(uv.y * 30.0)))) * uScan;
      uv.x += band * 0.006 * (hash(vec2(uTime, uv.y)) - 0.5) * 2.0;
      vec2 c = uv - 0.5;
      // very light chromatic fringing towards the edges, like a real lens
      float f = dot(c, c) * 0.0045 * uAberr;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * f).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * f).b;
      // scanlines rolling slowly down the screen
      float lines = 0.5 + 0.5 * sin((uv.y * uHeight * 0.5 + uTime * 6.0) * 3.14159);
      col *= 1.0 - uScan * 0.22 * lines;
      col += vec3(0.1, 0.35, 0.5) * band * 0.08;
      float v = smoothstep(0.85, 0.2, length(c * vec2(uAspect * 0.62, 1.0)));
      col *= mix(1.0 - uVignette, 1.0, v);
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 61.0) - 0.5;
      col += g * uGrain * (0.4 + 0.6 * (1.0 - dot(col, vec3(0.33))));
      gl_FragColor = vec4(col, 1.0);
    }
  `
}

/* ===================================================================== MINIMAL
 * Flat discs, straight hairline links and a plain background (dark or paper white).
 * No glow, no fog, no lens effects: the structure of the vault and nothing else. */

const NEURON_VARYINGS = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vPx;
varying float vState;
varying float vKind;
varying float vFog;
varying float vDim;
varying float vSeed;
varying float vBlur;
`

export const minimalNeuronFragment = /* glsl */ `
uniform vec3 uBg;
uniform float uLight;
${NEURON_VARYINGS}

void main() {
  vec2 p = vUv;
  float r = length(p);
  bool isMoc = vKind > 0.5 && vKind < 1.5;
  bool isAttachment = vKind > 1.5 && vKind < 2.5;
  bool isUnresolved = vKind > 2.5;
  float shapeR = isAttachment ? max(abs(p.x), abs(p.y)) * 1.12 : r;
  float aa = max(fwidth(shapeR), 0.004) * 1.2;
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, shapeR);
  if (alpha <= 0.001) discard;

  // on paper the soft palette needs a little more ink to stand out
  vec3 base = mix(vColor, pow(vColor, vec3(1.3)) * 0.9, uLight);
  vec3 col = base;
  // hubs read as targets: a ring of background inside the disc
  if (isMoc) {
    float ring = smoothstep(0.58 - aa, 0.58, r) * (1.0 - smoothstep(0.74 - aa, 0.74, r));
    col = mix(col, uBg, ring * 0.9 * smoothstep(3.0, 6.0, vPx));
  }
  if (isAttachment) col = mix(base, uBg, 0.4);
  if (isUnresolved) {
    alpha *= smoothstep(0.58 - aa, 0.58, r);
    col = mix(base, uBg, 0.3);
  }
  if (vState > 2.5) col = mix(col, uLight > 0.5 ? vec3(0.0) : vec3(1.0), 0.18);
  float fade = clamp(vDim * 0.85 + vFog * 0.45, 0.0, 0.92);
  gl_FragColor = vec4(mix(col, uBg, fade), alpha);
}
`

/** Selection and hover rings only, a few pixels away from the disc. */
export const minimalHaloFragment = /* glsl */ `
uniform float uLight;
${NEURON_VARYINGS}

void main() {
  float r = length(vUv);
  if (r < 0.98 || vState < 1.5) discard;
  float px = max(vPx, 1.0);
  float aa = fwidth(r) * 1.2;
  float at = min(1.0 + 4.0 / px, 1.85);
  float hw = 0.9 / px;
  float ring = 1.0 - smoothstep(hw, hw + aa, abs(r - at));
  vec3 ink = uLight > 0.5 ? vec3(0.06, 0.07, 0.1) : vec3(0.93, 0.94, 0.97);
  bool selected = vState < 2.5;
  vec3 col = selected ? ink : mix(vColor, ink, 0.35);
  float a = ring * (selected ? 1.0 : 0.6);
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}
`

export const minimalSynapseFragment = /* glsl */ `
uniform float uLight;
varying float vSide;
varying float vT;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;
varying float vState;

void main() {
  float core = 1.0 - smoothstep(0.45, 1.0, abs(vSide));
  float hl = vState > 0.5 ? 1.0 : 0.0;
  vec3 ink = uLight > 0.5 ? vec3(0.16, 0.18, 0.24) : vec3(0.6, 0.63, 0.72);
  vec3 col = mix(ink, uLight > 0.5 ? vColor * 0.75 : vColor, hl);
  gl_FragColor = vec4(col, min(vAlpha * core * (hl > 0.5 ? 1.1 : 0.85), 1.0));
}
`

/* ==================================================================== HOLOGRAM
 * A projection in thin air: wireframe globes, dashed light flowing along the links,
 * a grid on the floor, scanlines and a little glitching. Everything adds light. */

const HOLO = /* glsl */ `
const vec3 HOLO_CYAN = vec3(0.32, 0.86, 1.0);
vec3 holoTint(vec3 c) { return mix(c, HOLO_CYAN, 0.5) * 1.1; }
float holoHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`

export const holoNeuronFragment = /* glsl */ `
uniform float uTime;
uniform float uInterf;
${NEURON_VARYINGS}
${HOLO}

void main() {
  vec2 p = vUv;
  float r = length(p);
  bool isAttachment = vKind > 1.5 && vKind < 2.5;
  bool isUnresolved = vKind > 2.5;
  float px = max(vPx, 1.0);
  float shapeR = isAttachment ? max(abs(p.x), abs(p.y)) * 1.1 : r;
  float aa = max(fwidth(shapeR), 0.004) * 1.4;
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0, shapeR);
  if (inside <= 0.001) discard;

  // bright outline about a pixel wide, a faint body and a hot core
  float lw = clamp(1.1 / px, 0.02, 0.45);
  float rim = 1.0 - smoothstep(lw, lw + aa, abs(shapeR - (1.0 - lw)));
  float body = 0.1 + 0.12 * pow(r, 3.0);
  float core = exp(-r * r * 16.0) * (isUnresolved ? 0.0 : 0.9);

  // a slowly spinning wireframe globe, only when the neuron is big enough to read it
  float wire = 0.0;
  if (!isAttachment) {
    float sy = clamp(p.y, -0.995, 0.995);
    float lat = asin(sy) * 0.955;
    float ring = sqrt(1.0 - sy * sy);
    float lon = (asin(clamp(p.x / max(ring, 1e-3), -1.0, 1.0)) + uTime * 0.35 + vSeed * 6.283) * 0.955;
    float dl = abs(fract(lat + 0.5) - 0.5) / max(fwidth(lat), 1e-4);
    float dm = abs(fract(lon) - 0.5) / max(fwidth(lon), 1e-4);
    wire = (1.0 - smoothstep(0.6, 1.6, min(dl, dm))) * smoothstep(9.0, 30.0, px) * 0.55;
  }

  float k = rim * 0.95 + body + core + wire;
  if (isUnresolved) k = rim * 0.6;
  // the projection is not perfectly stable
  float flick = 1.0 - uInterf * 0.5 * step(0.985, holoHash(vec2(floor(uTime * 14.0), vSeed * 91.0)));
  float scan = 1.0 - uInterf * 0.3 * (0.5 + 0.5 * sin(gl_FragCoord.y * 1.7 - uTime * 9.0));
  vec3 col = holoTint(vColor);
  if (vState > 1.5 && vState < 2.5) col = mix(col, vec3(1.0), 0.45);
  if (vState > 2.5) k *= 1.35;
  float fade = (1.0 - vFog * 0.85) * (1.0 - vDim * 0.88);
  gl_FragColor = vec4(col * k * inside * flick * scan * fade * 0.85, 1.0);
}
`

export const holoHaloFragment = /* glsl */ `
uniform float uTime;
${NEURON_VARYINGS}
${HOLO}

void main() {
  float r = length(vUv);
  if (r < 0.98) discard;
  bool isMoc = vKind > 0.5 && vKind < 1.5;
  float px = max(vPx, 1.0);
  float a = atan(vUv.y, vUv.x) / 6.2832 + 0.5;
  float glow = exp(-(r - 1.0) * 3.0) * 0.09;
  float k = 0.0;
  if (isMoc) {
    // four corner brackets around the hubs
    float br = 1.0 - smoothstep(0.9 / px, 1.8 / px, abs(r - 1.5));
    k += br * step(0.62, abs(fract(a * 4.0) - 0.5) * 2.0) * 0.55;
    glow += exp(-(r - 1.0) * 2.0) * 0.05;
  }
  if (vState > 1.5 && vState < 2.5) {
    // rotating dashed targeting ring
    float ring = 1.0 - smoothstep(0.8 / px, 1.8 / px, abs(r - 1.4));
    k += ring * step(0.5, fract(a * 18.0 + uTime * 0.25)) * 1.1;
    float outer = 1.0 - smoothstep(0.5 / px, 1.4 / px, abs(r - 1.75));
    k += outer * step(0.85, fract(a * 4.0 - uTime * 0.12)) * 0.9;
    glow += exp(-(r - 1.0) * 2.4) * 0.2;
  } else if (vState > 2.5) {
    float ring = 1.0 - smoothstep(0.8 / px, 1.8 / px, abs(r - 1.35));
    k += ring * 0.6;
  }
  k *= smoothstep(3.0, 7.0, px);
  k += glow;
  k *= (1.0 - vFog * 0.85) * (1.0 - vDim * 0.9);
  if (k < 0.002) discard;
  gl_FragColor = vec4(mix(holoTint(vColor), vec3(1.0), 0.3) * k, 1.0);
}
`

export const holoSynapseFragment = /* glsl */ `
uniform float uTime;
uniform float uPulses;
varying float vSide;
varying float vT;
varying vec3 vColor;
varying float vAlpha;
varying float vSeed;
varying float vState;
${HOLO}

void main() {
  float core = exp(-vSide * vSide * 3.0);
  float hl = vState > 0.5 ? 1.0 : 0.0;
  // dashes of light streaming from source to target
  float flow = fract(vT * 10.0 - uTime * (0.25 + hl * 0.9) - vSeed * 5.0);
  float dash = mix(0.35, 1.0, step(0.5, flow));
  float packet = pow(1.0 - fract(vT - uTime * 0.3 - vSeed), 24.0) * (0.4 + uPulses);
  vec3 col = holoTint(vColor);
  gl_FragColor = vec4(col * core * (dash + packet * 2.0) * (1.0 + hl * 0.6), vAlpha * 1.2);
}
`

/** Projection floor: a fine grid with major lines, concentric rings and a slow radar pulse. */
export const gridVertex = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

export const gridFragment = /* glsl */ `
uniform float uTime;
uniform float uR;
uniform float uCell;
varying vec3 vW;
float gridLine(float x) {
  float d = abs(fract(x - 0.5) - 0.5) / max(fwidth(x), 1e-4);
  return 1.0 - min(d, 1.0);
}
void main() {
  vec2 p = vW.xz / uCell;
  float d = length(vW.xz) / uR;
  float minor = max(gridLine(p.x), gridLine(p.y)) * 0.22;
  float major = max(gridLine(p.x / 5.0), gridLine(p.y / 5.0)) * 0.5;
  float rings = gridLine(d * 8.0) * 0.35 * (1.0 - smoothstep(0.0, 0.6, d));
  float sweep = exp(-pow((d - fract(uTime * 0.06) * 1.3) * 14.0, 2.0)) * 0.5;
  float fade = 1.0 - smoothstep(0.25, 1.0, d);
  vec3 col = vec3(0.3, 0.78, 1.0) * (minor + major + rings + sweep) * fade;
  gl_FragColor = vec4(col * 0.32, 1.0);
}
`
