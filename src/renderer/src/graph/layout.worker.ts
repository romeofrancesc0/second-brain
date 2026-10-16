/// <reference lib="webworker" />
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ, type Simulation } from 'd3-force-3d'

export interface LayoutStart {
  type: 'start'
  count: number
  /** Flat pairs of node indices. */
  links: Int32Array
  /** Flat xyz; NaN means "no known position". */
  init: Float32Array
  /** Flat xyz cluster anchor per node. */
  anchors: Float32Array
  degree: Uint16Array
  alpha: number
}
export type LayoutIn = LayoutStart | { type: 'stop' }
export type LayoutOut =
  | { type: 'tick'; positions: Float32Array; progress: number }
  | { type: 'done'; positions: Float32Array }

interface N {
  x: number
  y: number
  z: number
  ax: number
  ay: number
  az: number
  deg: number
  [key: string]: unknown
}

const ALPHA_MIN = 0.002
let sim: Simulation<N> | null = null
let nodes: N[] = []
let generation = 0

function snapshot(): Float32Array {
  const out = new Float32Array(nodes.length * 3)
  for (let i = 0; i < nodes.length; i++) {
    out[i * 3] = nodes[i].x
    out[i * 3 + 1] = nodes[i].y
    out[i * 3 + 2] = nodes[i].z
  }
  return out
}

function start(msg: LayoutStart): void {
  sim?.stop()
  const gen = ++generation
  nodes = []
  for (let i = 0; i < msg.count; i++) {
    const ax = msg.anchors[i * 3]
    const ay = msg.anchors[i * 3 + 1]
    const az = msg.anchors[i * 3 + 2]
    let x = msg.init[i * 3]
    let y = msg.init[i * 3 + 1]
    let z = msg.init[i * 3 + 2]
    if (Number.isNaN(x)) {
      // Unknown position: seed close to the centre, slightly biased towards the cluster anchor,
      // so the network visibly "grows" outwards.
      const r = 6 + Math.random() * 20
      const u = Math.random() * 2 - 1
      const t = Math.random() * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      x = ax * 0.08 + r * s * Math.cos(t)
      y = ay * 0.08 + r * s * Math.sin(t)
      z = az * 0.08 + r * u
    }
    nodes.push({ x, y, z, ax, ay, az, deg: msg.degree[i] })
  }
  const links: { source: number; target: number }[] = []
  for (let i = 0; i < msg.links.length; i += 2) links.push({ source: msg.links[i], target: msg.links[i + 1] })

  const anchorStrength = 0.03
  sim = forceSimulation(nodes, 3)
    .alpha(msg.alpha)
    .alphaMin(ALPHA_MIN)
    .alphaDecay(1 - Math.pow(ALPHA_MIN, 1 / 320))
    .velocityDecay(0.38)
    .force(
      'link',
      forceLink<N, { source: number | N; target: number | N }>(links).distance((l) => {
        const s = l.source as N
        const t = l.target as N
        return 16 + 3.2 * Math.sqrt(Math.min(s.deg, t.deg))
      })
    )
    .force(
      'charge',
      forceManyBody<N>()
        .strength((n) => -26 - 5 * Math.sqrt(n.deg))
        .theta(0.92)
        .distanceMax(420)
    )
    .force('ax', forceX<N>((n) => n.ax).strength(anchorStrength))
    .force('ay', forceY<N>((n) => n.ay).strength(anchorStrength))
    .force('az', forceZ<N>((n) => n.az).strength(anchorStrength))
    .stop()

  const initialAlpha = msg.alpha
  const loop = (): void => {
    if (gen !== generation || !sim) return
    const t0 = performance.now()
    do sim.tick()
    while (performance.now() - t0 < 12 && sim.alpha() > ALPHA_MIN)
    const alpha = sim.alpha()
    const positions = snapshot()
    if (alpha <= ALPHA_MIN) {
      postMessage({ type: 'done', positions } satisfies LayoutOut, [positions.buffer])
      return
    }
    const progress = 1 - Math.log(alpha / ALPHA_MIN) / Math.log(initialAlpha / ALPHA_MIN)
    postMessage({ type: 'tick', positions, progress } satisfies LayoutOut, [positions.buffer])
    setTimeout(loop, 0)
  }
  loop()
}

self.onmessage = (e: MessageEvent<LayoutIn>) => {
  if (e.data.type === 'start') start(e.data)
  else {
    generation++
    sim?.stop()
  }
}
