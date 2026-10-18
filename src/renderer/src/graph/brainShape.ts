import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

/*
 * A stylised human brain, built procedurally, used by the hologram view.
 * Canonical space: x = front (+) to back (−), y = up, z = left/right; the cerebrum is about 2 units long.
 * The cerebrum is a star-shaped surface: its radius is a function of the direction from the centre,
 * which also lets the network be warped inside it (see warpIntoBrain).
 */

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** Distance from the centre to the surface of the cerebrum along the unit direction (x, y, z). */
export function cerebrumRadius(x: number, y: number, z: number): number {
  const a = 1.0 - 0.07 * smooth(-0.2, 0.5, x) // the frontal lobe is a little shorter than the occipital
  const b = 0.42 + 0.3 * smooth(-0.55, 0.2, y) // flat underside, domed top
  const c = 0.74
  let r = 1 / Math.sqrt((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2)
  // temporal lobes: low on the sides, towards the front
  r *= 1 + 0.08 * Math.exp(-((x - 0.12) ** 2 / 0.07 + (y + 0.42) ** 2 / 0.035)) * smooth(0.25, 0.7, Math.abs(z))
  // room underneath the occipital lobe for the cerebellum
  r *= 1 - 0.2 * Math.exp(-((x + 0.72) ** 2 / 0.05 + (y + 0.55) ** 2 / 0.05))
  // longitudinal fissure between the two hemispheres
  r *= 1 - 0.085 * Math.exp(-(z * z) / 0.0022) * smooth(-0.35, 0.15, y)
  // lateral (Sylvian) sulcus, rising towards the back above the temporal lobe
  const s = y - (-0.2 + (0.4 - x) * 0.45)
  r *= 1 - 0.045 * Math.exp(-(s * s) / 0.0016) * smooth(-0.35, 0.1, x) * (1 - smooth(0.35, 0.6, x)) * smooth(0.35, 0.7, Math.abs(z))
  return r
}

/* ------------------------------------------------------------- 3D noise */

const perm = new Uint8Array(512)
{
  // fixed seed: the brain always has the same folds
  const p = Array.from({ length: 256 }, (_, i) => i)
  let seed = 1337
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647
    const j = seed % (i + 1)
    ;[p[i], p[j]] = [p[j], p[i]]
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]
}
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
function grad(h: number, x: number, y: number, z: number): number {
  const u = h < 8 ? x : y
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
}

/** Classic Perlin noise, roughly in [-1, 1]. */
export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x) & 255
  const Y = Math.floor(y) & 255
  const Z = Math.floor(z) & 255
  x -= Math.floor(x)
  y -= Math.floor(y)
  z -= Math.floor(z)
  const u = fade(x)
  const v = fade(y)
  const w = fade(z)
  const A = perm[X] + Y
  const AA = perm[A] + Z
  const AB = perm[A + 1] + Z
  const B = perm[X + 1] + Y
  const BA = perm[B] + Z
  const BB = perm[B + 1] + Z
  return lerp(
    lerp(lerp(grad(perm[AA] & 15, x, y, z), grad(perm[BA] & 15, x - 1, y, z), u), lerp(grad(perm[AB] & 15, x, y - 1, z), grad(perm[BB] & 15, x - 1, y - 1, z), u), v),
    lerp(
      lerp(grad(perm[AA + 1] & 15, x, y, z - 1), grad(perm[BA + 1] & 15, x - 1, y, z - 1), u),
      lerp(grad(perm[AB + 1] & 15, x, y - 1, z - 1), grad(perm[BB + 1] & 15, x - 1, y - 1, z - 1), u),
      v
    ),
    w
  )
}

/** Gyri (1) and sulci (0): the zero crossings of a domain-warped noise become the grooves. */
function gyri(x: number, y: number, z: number, freq: number): number {
  const wx = noise3(x * 1.7 + 11, y * 1.7, z * 1.7) * 0.35
  const wy = noise3(x * 1.7, y * 1.7 + 23, z * 1.7) * 0.35
  const n = noise3((x + wx) * freq, (y + wy) * freq * 1.15, (z + (z > 0 ? 7 : -7)) * freq)
  return smooth(0.015, 0.2, Math.abs(n))
}

/* ------------------------------------------------------------- geometry */

/** Adds an `aFold` attribute (1 on gyri, 0 in the sulci) and pushes the sulci inwards. */
function sculpt(geo: THREE.BufferGeometry, surface: (p: THREE.Vector3) => { r: number; fold: number }): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute
  const fold = new Float32Array(pos.count)
  const p = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i)
    const s = surface(p)
    fold[i] = s.fold
    pos.setXYZ(i, p.x * s.r, p.y * s.r, p.z * s.r)
  }
  geo.setAttribute('aFold', new THREE.BufferAttribute(fold, 1))
  geo.computeVertexNormals()
  return geo
}

/** Cerebrum, cerebellum and brainstem in one geometry (position, normal, aFold). */
export function buildBrainGeometry(): THREE.BufferGeometry {
  // cerebrum: a finely subdivided sphere shaped by cerebrumRadius, with folds
  let cerebrum: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 56)
  cerebrum.deleteAttribute('normal')
  cerebrum.deleteAttribute('uv')
  cerebrum = mergeVertices(cerebrum)
  sculpt(cerebrum, (d) => {
    d.normalize()
    const R = cerebrumRadius(d.x, d.y, d.z)
    const g = gyri(d.x * R, d.y * R, d.z * R, 4.6)
    // the fissure itself stays smooth so the two hemispheres read clearly
    return { r: R * (1 + 0.022 * (g - 1)), fold: g }
  })

  // cerebellum: a flattened ellipsoid under the occipital lobe, with fine horizontal folia
  let cerebellum: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 28)
  cerebellum.deleteAttribute('normal')
  cerebellum.deleteAttribute('uv')
  cerebellum = mergeVertices(cerebellum)
  sculpt(cerebellum, (d) => {
    d.normalize()
    const folia = smooth(0.08, 0.5, Math.abs(Math.sin((d.y * 0.9 + d.x * 0.25) * 26 + noise3(d.x * 3, d.y * 3, d.z * 3) * 2)))
    const vermis = 1 - 0.12 * Math.exp(-(d.z * d.z) / 0.01) * smooth(-0.2, 0.4, d.y)
    return { r: (1 + 0.035 * (folia - 1)) * vermis, fold: folia }
  })
  cerebellum.scale(0.25, 0.155, 0.42)
  cerebellum.translate(-0.66, -0.41, 0)
  cerebellum.computeVertexNormals()

  // brainstem: a short tapered column going down and slightly back
  const stem = new THREE.CylinderGeometry(0.1, 0.065, 0.42, 40, 12, true)
  stem.deleteAttribute('uv')
  stem.rotateZ(-0.22)
  stem.translate(-0.3, -0.6, 0)
  stem.setAttribute('aFold', new THREE.BufferAttribute(new Float32Array(stem.getAttribute('position').count).fill(1), 1))

  return mergeGeometries([cerebrum, cerebellum, mergeVertices(stem)])
}

/* ------------------------------------------------------------------ warp */

export interface BrainFit {
  center: THREE.Vector3
  /** Spread of the layout along each axis. */
  radii: THREE.Vector3
  /** Size of the brain in world units (canonical units × scale). */
  scale: number
}

/** Fits the brain to a layout: same centre, about the same volume. */
export function fitBrain(layout: Float32Array, count: number): BrainFit {
  const c = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    c.x += layout[i * 3]
    c.y += layout[i * 3 + 1]
    c.z += layout[i * 3 + 2]
  }
  if (count) c.divideScalar(count)
  const v = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    v.x += (layout[i * 3] - c.x) ** 2
    v.y += (layout[i * 3 + 1] - c.y) ** 2
    v.z += (layout[i * 3 + 2] - c.z) ** 2
  }
  const radii = new THREE.Vector3(Math.sqrt(v.x / Math.max(count, 1)), Math.sqrt(v.y / Math.max(count, 1)), Math.sqrt(v.z / Math.max(count, 1)))
    .multiplyScalar(2.1)
    .max(new THREE.Vector3(30, 30, 30))
  const scale = Math.cbrt((radii.x * radii.y * radii.z) / (1 * 0.6 * 0.74)) * 1.05
  return { center: c, radii, scale }
}

/**
 * Moves every neuron inside the cerebrum: the layout's spread is mapped onto a unit ball (outliers are
 * pulled in smoothly) and the ball is stretched to the shape of the brain. Regions keep their direction
 * from the centre, so each one becomes a lobe-like area of the brain.
 */
export function warpIntoBrain(layout: Float32Array, out: Float32Array, count: number, fit: BrainFit, k: number): void {
  const { center: c, radii, scale } = fit
  const e = k * k * (3 - 2 * k)
  for (let i = 0; i < count; i++) {
    const o = i * 3
    const px = layout[o]
    const py = layout[o + 1]
    const pz = layout[o + 2]
    if (e <= 0) {
      out[o] = px
      out[o + 1] = py
      out[o + 2] = pz
      continue
    }
    const ux = (px - c.x) / radii.x
    const uy = (py - c.y) / radii.y
    const uz = (pz - c.z) / radii.z
    const r = Math.hypot(ux, uy, uz)
    let bx = c.x
    let by = c.y
    let bz = c.z
    if (r > 1e-6) {
      const dx = ux / r
      const dy = uy / r
      const dz = uz / r
      // ~95% of the layout lands in the outer part of the brain, outliers are pulled just under the surface
      const rr = Math.min((0.84 * Math.tanh(r * 1.8)) / Math.tanh(1.8), 0.9) * cerebrumRadius(dx, dy, dz) * scale
      bx += dx * rr
      by += dy * rr
      bz += dz * rr
    }
    out[o] = px + (bx - px) * e
    out[o + 1] = py + (by - py) * e
    out[o + 2] = pz + (bz - pz) * e
  }
}
