import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import type { AppSettings, GraphNode, ViewMode } from '@shared/types'
import {
  dustFragment,
  dustVertex,
  filmShader,
  gridFragment,
  gridVertex,
  hazeFragment,
  hazeVertex,
  haloFragment,
  haloVertex,
  holoHaloFragment,
  holoNeuronFragment,
  holoSynapseFragment,
  minimalHaloFragment,
  minimalNeuronFragment,
  minimalSynapseFragment,
  neuronFragment,
  neuronVertex,
  skyFragment,
  skyVertex,
  synapseFragment,
  synapseVertex
} from './shaders'
import type { LayoutOut, LayoutStart } from './layout.worker'
import { Labels } from './Labels'
import { backgroundOf, isLight } from './views'
import { brainFragment, brainVertex } from './shaders'
import { buildBrainGeometry, fitBrain, warpIntoBrain, type BrainFit } from './brainShape'

const KIND_CODE: Record<GraphNode['kind'], number> = { note: 0, moc: 1, attachment: 2, unresolved: 3 }
const STATE = { idle: 0, linked: 1, selected: 2, hovered: 3 } as const
/** Background colour, also used as the fog colour of the solid neurons. */
export const BACKGROUND = '#090b11'
/** Synapses are drawn as curved ribbons made of SEG segments. */
const SEG = 6
const VPL = (SEG + 1) * 2
const HAZE_BLOBS = 9
/** Frame rate while nothing moves: the scene stays the same, only the slow shader effects advance. */
const REST_FPS = 1
/** How long the loop keeps the full frame rate after the last input or animation. */
const LINGER_MS = 1800
/** Damping of the orbit controls per frame at 60 fps (scaled to the actual frame time). */
const DAMPING = 0.07

export interface BrainGraph {
  nodes: GraphNode[]
  /** Pairs of indices into `nodes`. */
  links: [number, number][]
  colors: Map<string, THREE.Color>
  /** Known positions by node id (previous layout or previous frame). */
  known: Map<string, [number, number, number]>
  /** Group order used to place cluster anchors (largest first). */
  groups: string[]
}

/** Fragment shaders and blending of each view (the vertex stage is shared). */
const LOOKS: Record<ViewMode, { neuron: string; halo: string; synapse: string }> = {
  nebula: { neuron: neuronFragment, halo: haloFragment, synapse: synapseFragment },
  minimal: { neuron: minimalNeuronFragment, halo: minimalHaloFragment, synapse: minimalSynapseFragment },
  hologram: { neuron: holoNeuronFragment, halo: holoHaloFragment, synapse: holoSynapseFragment }
}

interface Flight {
  fromPos: THREE.Vector3
  toPos: THREE.Vector3
  fromTarget: THREE.Vector3
  toTarget: THREE.Vector3
  t0: number
  duration: number
}

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export class Brain {
  onSelect?: (id: string | null) => void
  onHover?: (id: string | null) => void
  onLayout?: (progress: number, done: boolean) => void

  readonly renderer: THREE.WebGLRenderer
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  private scene = new THREE.Scene()
  private root = new THREE.Group()
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private timer = new THREE.Timer()
  private worker: Worker
  private labels: Labels

  // graph state
  nodes: GraphNode[] = []
  private links: [number, number][] = []
  private indexById = new Map<string, number>()
  private neighbours: number[][] = []
  /** Where each neuron is drawn (the layout, possibly warped into the hologram brain). */
  positions = new Float32Array(0)
  /** The force layout itself, as computed by the worker and saved between sessions. */
  layoutPositions = new Float32Array(0)
  private warp = 0
  /** Re-frame the overview once the network has flowed into (or out of) the brain. */
  private reframe = false
  private brainFit: BrainFit | null = null
  private brainMesh: THREE.Mesh | null = null
  private brainMat: THREE.ShaderMaterial
  private radii = new Float32Array(0)
  private visible = new Uint8Array(0)
  private hiddenGroups = new Set<string>()
  private colors = new Map<string, THREE.Color>()

  // gpu objects
  private neuronMesh: THREE.Mesh | null = null
  private haloMesh: THREE.Mesh | null = null
  private hazeMesh: THREE.Mesh | null = null
  private hazeMat!: THREE.ShaderMaterial
  private film!: ShaderPass
  private lastHaze = 0
  private synapseMesh: THREE.Mesh | null = null
  private neuronMat: THREE.ShaderMaterial
  private haloMat: THREE.ShaderMaterial
  private synapseMat: THREE.ShaderMaterial
  private dust: THREE.Points
  private dustMat: THREE.ShaderMaterial
  private sky: THREE.Mesh
  private grid: THREE.Mesh
  private gridMat: THREE.ShaderMaterial
  private uniforms: Record<string, THREE.IUniform>
  private view: ViewMode | null = null
  private light = false

  // interaction state
  selected = -1
  private hovered = -1
  private focusGroup: string | null = null
  private agentFocus = new Set<number>()
  private dimTarget = 0
  private flight: Flight | null = null
  private keys = new Set<string>()
  private pointer = { x: 0, y: 0, downX: 0, downY: 0, down: false, moved: false, inside: false }
  private positionsDirty = false
  private layoutRunning = false
  private settings: AppSettings
  private screen = new Float32Array(0) // x, y, depth, radiusPx per node
  private projMatrix = new THREE.Matrix4()
  private lastInteraction = performance.now()
  private boundsRadius = 400

  // render loop: full frame rate while something moves, REST_FPS otherwise, nothing while hidden
  private fps = 60
  /** Animations and app events keep the full rate until then (only while the window has focus). */
  private activeUntil = 0
  /** Direct input on the canvas keeps the full rate until then, even without focus. */
  private inputUntil = 0
  private focused = document.hasFocus()
  private lastFrameAt = 0
  private rafId = 0
  private restTimer = 0

  constructor(
    private container: HTMLElement,
    labelLayer: HTMLElement,
    settings: AppSettings
  ) {
    this.settings = settings
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.toneMappingExposure = 1.0
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 40000)
    this.camera.position.set(0, 300, 2600)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = DAMPING
    this.controls.rotateSpeed = 0.55
    this.controls.zoomSpeed = 1.0
    this.controls.panSpeed = 0.8
    this.controls.zoomToCursor = true
    this.controls.minDistance = 4
    this.controls.maxDistance = 9000
    this.controls.autoRotateSpeed = 0.25
    this.controls.addEventListener('start', () => {
      this.flight = null
      this.lastInteraction = performance.now()
      this.requestActive(LINGER_MS, true)
    })

    this.scene.add(this.root)

    const bg = new THREE.Color(BACKGROUND)
    const sharedUniforms = {
      uTime: { value: 0 },
      uPixelScale: { value: 0.001 },
      uDim: { value: 0 },
      uFogNear: { value: 2000 },
      uFogFar: { value: 6000 },
      uScale: { value: 1 },
      uBg: { value: bg },
      uFocus: { value: 1000 },
      uDof: { value: 0.7 },
      uAtmos: { value: 1 },
      uLight: { value: 0 },
      uInterf: { value: 0 },
      uReveal: { value: 0 },
      uMaxPx: { value: 420 }
    }
    this.uniforms = sharedUniforms
    // solid soma: opaque, writes depth so neurons and synapses occlude each other properly
    this.neuronMat = new THREE.ShaderMaterial({
      uniforms: { ...sharedUniforms, uQuad: { value: 1 } },
      vertexShader: neuronVertex,
      fragmentShader: neuronFragment,
      alphaToCoverage: true
    })
    this.haloMat = new THREE.ShaderMaterial({
      uniforms: { ...sharedUniforms, uQuad: { value: 2.0 } },
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    this.synapseMat = new THREE.ShaderMaterial({
      uniforms: {
        ...sharedUniforms,
        uWidth: { value: 0.14 },
        uOpacity: { value: 1 },
        uPulses: { value: 0 },
        uHlGain: { value: 1 },
        uCurve: { value: 1 }
      },
      vertexShader: synapseVertex,
      fragmentShader: synapseFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    })

    // background: plain dark gradient + a little dust for parallax while orbiting
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(30000, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: { uBg: sharedUniforms.uBg, uAtmos: sharedUniforms.uAtmos },
        vertexShader: skyVertex,
        fragmentShader: skyFragment,
        side: THREE.BackSide,
        depthWrite: false
      })
    )
    this.sky.renderOrder = -10
    this.scene.add(this.sky)

    // dust and soft bokeh scattered through the whole volume of the network (scaled to it in fitVolume)
    const dustCount = 3600
    const dustPos = new Float32Array(dustCount * 3)
    const dustSeed = new Float32Array(dustCount)
    for (let i = 0; i < dustCount; i++) {
      const r = Math.cbrt(Math.random()) * 2.3
      const u = Math.random() * 2 - 1
      const t = Math.random() * Math.PI * 2
      const k = Math.sqrt(1 - u * u)
      dustPos.set([r * k * Math.cos(t), r * u * 0.8, r * k * Math.sin(t)], i * 3)
      dustSeed[i] = Math.random()
    }
    const dustGeo = new THREE.BufferGeometry()
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3))
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(dustSeed, 1))
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: {
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uFocus: sharedUniforms.uFocus,
        uTime: sharedUniforms.uTime,
        uDust: { value: 1 }
      },
      vertexShader: dustVertex,
      fragmentShader: dustFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    this.dust = new THREE.Points(dustGeo, this.dustMat)
    this.dust.renderOrder = -5
    this.dust.frustumCulled = false
    this.scene.add(this.dust)

    // volumetric haze: soft clouds tinted with the colour of each region
    const hazeQuad = new THREE.PlaneGeometry(2, 2)
    const hazeGeo = new THREE.InstancedBufferGeometry()
    hazeGeo.index = hazeQuad.index
    hazeGeo.setAttribute('position', hazeQuad.getAttribute('position'))
    const cap = HAZE_BLOBS * 48
    hazeGeo.setAttribute('aCenter', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage))
    hazeGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage))
    hazeGeo.setAttribute('aRadius', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage))
    hazeGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage))
    hazeGeo.instanceCount = 0
    this.hazeMat = new THREE.ShaderMaterial({
      uniforms: { uHaze: { value: 1 }, uTime: sharedUniforms.uTime, uPixelScale: sharedUniforms.uPixelScale, uCamDist: { value: 1000 } },
      vertexShader: hazeVertex,
      fragmentShader: hazeFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    this.hazeMesh = new THREE.Mesh(hazeGeo, this.hazeMat)
    this.hazeMesh.frustumCulled = false
    this.hazeMesh.renderOrder = -3
    this.root.add(this.hazeMesh)

    // hologram: projection grid on the floor below the network
    this.gridMat = new THREE.ShaderMaterial({
      uniforms: { uTime: sharedUniforms.uTime, uR: { value: 2000 }, uCell: { value: 40 } },
      vertexShader: gridVertex,
      fragmentShader: gridFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    })
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), this.gridMat)
    this.grid.renderOrder = -4
    this.grid.frustumCulled = false
    this.grid.visible = false
    this.scene.add(this.grid)

    // hologram: the brain shell, built lazily the first time the view is shown
    this.brainMat = new THREE.ShaderMaterial({
      uniforms: { uTime: sharedUniforms.uTime, uShell: { value: 1 }, uInterf: sharedUniforms.uInterf },
      vertexShader: brainVertex,
      fragmentShader: brainFragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    })

    // multisampled target: antialiases sphere edges (alpha-to-coverage) and thin synapses
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(this.renderer, target)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.25, 0.4, 0.55)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.film = new ShaderPass(filmShader as never)
    this.composer.addPass(this.film)

    this.labels = new Labels(labelLayer)

    this.worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<LayoutOut>) => this.onWorker(e.data)

    this.bindEvents()
    this.bindLoopEvents()
    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
    this.applySettings(settings)
    this.timer.connect(document)
    this.requestActive()
  }

  /* ------------------------------------------------------------ render loop */

  /**
   * Keeps the loop at the full frame rate for `ms` (from the next frame on, so it starts at once).
   * Without window focus only `input` (the user acting on the canvas) does; the rest waits at REST_FPS.
   */
  requestActive(ms = LINGER_MS, input = false): void {
    const until = performance.now() + ms
    if (input) this.inputUntil = Math.max(this.inputUntil, until)
    this.activeUntil = Math.max(this.activeUntil, until)
    this.invalidate()
  }

  /** Draws a new frame as soon as possible, even while resting. */
  invalidate(): void {
    if (document.hidden || this.rafId) return
    clearTimeout(this.restTimer)
    this.restTimer = 0
    this.rafId = requestAnimationFrame(this.tick)
  }

  private get active(): boolean {
    const now = performance.now()
    return now < this.inputUntil || (this.focused && now < this.activeUntil)
  }

  private tick = (): void => {
    this.rafId = 0
    if (document.hidden) return
    const now = performance.now()
    const interval = 1000 / this.fps
    // the display may refresh faster than the chosen rate: skip vsyncs until the next frame is due
    if (now - this.lastFrameAt < interval - 4) {
      this.rafId = requestAnimationFrame(this.tick)
      return
    }
    // keep a steady cadence (e.g. 24 fps on a 60 Hz display), restarting it after a pause
    this.lastFrameAt = now - this.lastFrameAt > interval * 2 ? now : this.lastFrameAt + interval
    this.frame()
    this.scheduleNext()
  }

  private scheduleNext(): void {
    if (document.hidden || this.rafId || this.restTimer) return
    if (this.active) this.rafId = requestAnimationFrame(this.tick)
    else this.restTimer = window.setTimeout(() => this.invalidate(), 1000 / REST_FPS)
  }

  private bindLoopEvents(): void {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // hidden or minimised: stop drawing altogether
        cancelAnimationFrame(this.rafId)
        clearTimeout(this.restTimer)
        this.rafId = this.restTimer = 0
      } else this.requestActive()
    })
    window.addEventListener('focus', () => {
      this.focused = true
      this.requestActive()
    })
    window.addEventListener('blur', () => {
      this.focused = false
    })
  }

  /* ------------------------------------------------------------ public api */

  setGraph(graph: BrainGraph, intro: boolean): void {
    const prevSelectedId = this.selected >= 0 ? this.nodes[this.selected]?.id : null
    const prevAgentIds = [...this.agentFocus].map((i) => this.nodes[i]?.id).filter(Boolean) as string[]
    this.nodes = graph.nodes
    this.links = graph.links
    this.colors = graph.colors
    this.cssColors.clear()
    this.indexById = new Map(this.nodes.map((n, i) => [n.id, i]))
    const n = this.nodes.length

    this.neighbours = Array.from({ length: n }, () => [])
    const degree = new Uint16Array(n)
    for (const [a, b] of this.links) {
      this.neighbours[a].push(b)
      this.neighbours[b].push(a)
      degree[a]++
      degree[b]++
    }

    // radius: hubs are bigger, long notes slightly bigger
    this.radii = new Float32Array(n)
    this.nodes.forEach((node, i) => {
      const base = node.kind === 'moc' ? 4.2 : node.kind === 'attachment' ? 1.1 : node.kind === 'unresolved' ? 1.0 : 1.35
      this.radii[i] = base + 0.62 * Math.log2(1 + degree[i]) + 0.18 * Math.log10(1 + node.words)
    })

    // cluster anchors on a squashed Fibonacci sphere: the clusters become "lobes"
    const anchorRadius = 34 * Math.cbrt(n)
    this.boundsRadius = anchorRadius * 1.35
    const anchorOf = new Map<string, [number, number, number]>()
    const g = graph.groups.length
    graph.groups.forEach((group, i) => {
      const theta = i * Math.PI * (3 - Math.sqrt(5))
      const y = g === 1 ? 0 : 1 - (i / (g - 1)) * 2
      const rr = Math.sqrt(1 - y * y)
      anchorOf.set(group, [Math.cos(theta) * rr * anchorRadius * 1.25, y * anchorRadius * 0.8, Math.sin(theta) * rr * anchorRadius])
    })

    const anchors = new Float32Array(n * 3)
    const init = new Float32Array(n * 3).fill(NaN)
    this.layoutPositions = new Float32Array(n * 3)
    this.positions = new Float32Array(n * 3)
    let knownCount = 0
    this.nodes.forEach((node, i) => {
      const a = anchorOf.get(node.group) ?? [0, 0, 0]
      anchors.set(a, i * 3)
      const k = graph.known.get(node.id)
      if (k) {
        init.set(k, i * 3)
        this.layoutPositions.set(k, i * 3)
        knownCount++
      }
    })
    // new nodes appear next to an already placed neighbour
    this.nodes.forEach((node, i) => {
      if (!Number.isNaN(init[i * 3])) return
      const placed = this.neighbours[i].find((j) => !Number.isNaN(init[j * 3]))
      if (placed !== undefined && knownCount > 0) {
        for (let d = 0; d < 3; d++) init[i * 3 + d] = init[placed * 3 + d] + (Math.random() - 0.5) * 20
        this.layoutPositions.set(init.subarray(i * 3, i * 3 + 3), i * 3)
      } else if (knownCount > 0) {
        for (let d = 0; d < 3; d++) init[i * 3 + d] = anchors[i * 3 + d] + (Math.random() - 0.5) * 40
        this.layoutPositions.set(init.subarray(i * 3, i * 3 + 3), i * 3)
      }
    })

    this.visible = new Uint8Array(n).fill(1)
    this.screen = new Float32Array(n * 4)
    this.brainFit = knownCount ? fitBrain(this.layoutPositions, n) : null
    this.updateDisplay()
    this.buildNeurons()
    this.buildSynapses()
    this.applyVisibility()

    this.selected = prevSelectedId ? (this.indexById.get(prevSelectedId) ?? -1) : -1
    this.agentFocus = new Set(
      prevAgentIds.map((id) => this.indexById.get(id)).filter((i): i is number => i !== undefined)
    )
    this.hovered = -1
    this.refreshStates()

    const flatLinks = new Int32Array(this.links.length * 2)
    this.links.forEach(([a, b], i) => flatLinks.set([a, b], i * 2))
    const coverage = n ? knownCount / n : 0
    const msg: LayoutStart = {
      type: 'start',
      count: n,
      links: flatLinks,
      init,
      anchors,
      degree,
      alpha: coverage > 0.95 ? 0.06 : coverage > 0.5 ? 0.35 : 1
    }
    this.layoutRunning = true
    this.worker.postMessage(msg)
    this.requestActive()
    this.rebuildHaze()

    if (intro) {
      this.camera.position.copy(this.homeOffset().multiplyScalar(2.6))
      this.controls.target.set(0, 0, 0)
      this.flyTo(this.homeTarget(), this.homeOffset(), 3200)
    }
  }

  relayout(): void {
    const known = new Map<string, [number, number, number]>()
    this.setGraph(
      { nodes: this.nodes, links: this.links, colors: this.colors, known, groups: this.groupOrder() },
      false
    )
  }

  /** Centre of the overview: the middle of the hologram brain, or the origin of the layout. */
  private homeTarget(): THREE.Vector3 {
    return this.view === 'hologram' && this.brainFit ? this.brainFit.center.clone() : new THREE.Vector3(0, 0, 0)
  }

  /** Camera offset from the centre for the overview: slightly from above. */
  private homeOffset(): THREE.Vector3 {
    return new THREE.Vector3(0, 0.32, 1).normalize().multiplyScalar(this.boundsRadius * 2.7)
  }

  /** Zooms towards the orbit target (factor < 1 gets closer). */
  zoom(factor: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target)
    const dist = THREE.MathUtils.clamp(offset.length() * factor, this.controls.minDistance, this.controls.maxDistance)
    this.lastInteraction = performance.now()
    this.flyTo(this.controls.target.clone(), offset.setLength(dist), 380)
  }

  private groupOrder(): string[] {
    const counts = new Map<string, number>()
    for (const n of this.nodes) counts.set(n.group, (counts.get(n.group) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g)
  }

  getLayout(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {}
    this.nodes.forEach((n, i) => {
      out[n.id] = [
        Math.round(this.layoutPositions[i * 3] * 10) / 10,
        Math.round(this.layoutPositions[i * 3 + 1] * 10) / 10,
        Math.round(this.layoutPositions[i * 3 + 2] * 10) / 10
      ]
    })
    return out
  }

  select(id: string | null, fly = true): void {
    const idx = id ? (this.indexById.get(id) ?? -1) : -1
    this.selected = idx
    this.refreshStates()
    if (idx >= 0 && fly) this.flyToNode(idx)
    this.onSelect?.(idx >= 0 ? this.nodes[idx].id : null)
  }

  setFocusGroup(group: string | null): void {
    this.focusGroup = group
    this.refreshStates()
  }

  /** Highlights the neurons the agent is working on; optionally flies the camera to frame them. */
  setAgentFocus(ids: string[], fly: boolean): void {
    this.agentFocus = new Set(ids.map((id) => this.indexById.get(id)).filter((i): i is number => i !== undefined))
    this.refreshStates()
    if (!fly || !this.agentFocus.size || this.selected >= 0) return
    const pts = [...this.agentFocus].map((i) => this.nodeWorld(i))
    const center = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(pts.length)
    const spread = Math.max(...pts.map((p) => p.distanceTo(center)))
    const dist = THREE.MathUtils.clamp(spread * 2.6, 60, this.boundsRadius * 3)
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0, 0, 1)
    this.flyTo(center, dir.multiplyScalar(dist), 1100)
  }

  setHiddenGroups(groups: Set<string>): void {
    this.hiddenGroups = new Set(groups)
    this.applyVisibility()
  }

  /** Rebuilds the haze clouds from the current layout: a few blobs per region, following its shape. */
  private rebuildHaze(): void {
    const mesh = this.hazeMesh
    if (!mesh) return
    const geo = mesh.geometry as THREE.InstancedBufferGeometry
    const center = geo.getAttribute('aCenter') as THREE.BufferAttribute
    const color = geo.getAttribute('aColor') as THREE.BufferAttribute
    const radius = geo.getAttribute('aRadius') as THREE.BufferAttribute
    const seed = geo.getAttribute('aSeed') as THREE.BufferAttribute
    const byGroup = new Map<string, number[]>()
    this.nodes.forEach((n, i) => {
      if (n.kind === 'unresolved' || (n.kind === 'attachment' && !this.visible[i])) return
      if (!this.visible[i]) return
      ;(byGroup.get(n.group) ?? byGroup.set(n.group, []).get(n.group)!).push(i)
    })
    const p = this.positions
    let count = 0
    const cap = center.count
    for (const [group, members] of byGroup) {
      if (members.length < 10) continue
      const c = this.colors.get(group) ?? new THREE.Color('#9fb0cf')
      const blobs = Math.min(HAZE_BLOBS, Math.max(2, Math.round(members.length / 18)))
      // tiny k-means: seeds picked evenly among members, two refinement passes
      const cs: number[] = []
      for (let b = 0; b < blobs; b++) {
        const m = members[Math.floor(((b + 0.5) / blobs) * members.length)]
        cs.push(p[m * 3], p[m * 3 + 1], p[m * 3 + 2])
      }
      const assign = new Int32Array(members.length)
      for (let pass = 0; pass < 3; pass++) {
        const sum = new Float64Array(blobs * 4)
        members.forEach((m, k) => {
          let best = 0
          let bd = Infinity
          for (let b = 0; b < blobs; b++) {
            const dx = p[m * 3] - cs[b * 3]
            const dy = p[m * 3 + 1] - cs[b * 3 + 1]
            const dz = p[m * 3 + 2] - cs[b * 3 + 2]
            const d = dx * dx + dy * dy + dz * dz
            if (d < bd) {
              bd = d
              best = b
            }
          }
          assign[k] = best
          sum[best * 4] += p[m * 3]
          sum[best * 4 + 1] += p[m * 3 + 1]
          sum[best * 4 + 2] += p[m * 3 + 2]
          sum[best * 4 + 3]++
        })
        for (let b = 0; b < blobs; b++) {
          const n = sum[b * 4 + 3]
          if (n > 0) cs[b * 3] = sum[b * 4] / n, (cs[b * 3 + 1] = sum[b * 4 + 1] / n), (cs[b * 3 + 2] = sum[b * 4 + 2] / n)
        }
      }
      const sq = new Float64Array(blobs)
      const cnt = new Float64Array(blobs)
      members.forEach((m, k) => {
        const b = assign[k]
        const dx = p[m * 3] - cs[b * 3]
        const dy = p[m * 3 + 1] - cs[b * 3 + 1]
        const dz = p[m * 3 + 2] - cs[b * 3 + 2]
        sq[b] += dx * dx + dy * dy + dz * dz
        cnt[b]++
      })
      for (let b = 0; b < blobs && count < cap; b++) {
        if (cnt[b] < 3) continue
        const r = Math.max(Math.sqrt(sq[b] / cnt[b]) * 2.4, 36)
        center.setXYZ(count, cs[b * 3], cs[b * 3 + 1], cs[b * 3 + 2])
        color.setXYZ(count, c.r, c.g, c.b)
        radius.setX(count, r)
        seed.setX(count, ((hashString(group) * 97 + b * 0.173) % 1) + 0.01)
        count++
      }
    }
    geo.instanceCount = count
    center.needsUpdate = color.needsUpdate = radius.needsUpdate = seed.needsUpdate = true
  }

  /** Scales dust and clouds to the size of the network. */
  private fitVolume(): void {
    this.dust.scale.setScalar(Math.max(this.boundsRadius, 120))
    // the hologram floor sits just below the lowest neurons
    let minY = 0
    for (let i = 1; i < this.positions.length; i += 3) minY = Math.min(minY, this.positions[i])
    const r = Math.max(this.boundsRadius, 120)
    this.grid.position.y = minY - r * 0.12
    // under the hologram brain the floor sits just below the brainstem
    if (this.view === 'hologram' && this.brainFit) this.grid.position.y = this.brainFit.center.y - this.brainFit.scale * 1.08
    this.grid.scale.setScalar(r * 3.2)
    this.gridMat.uniforms.uR.value = r * 3.2
    this.gridMat.uniforms.uCell.value = r / 7
  }

  applySettings(s: AppSettings): void {
    this.settings = s
    this.fps = s.fps ?? 60
    const light = isLight(s)
    if (s.view !== this.view || light !== this.light) this.setLook(s.view, light)
    const u = this.uniforms
    const atmos = s.atmosphere ?? 1
    if (s.view === 'nebula') {
      this.hazeMat.uniforms.uHaze.value = atmos * 1.1
      this.dustMat.uniforms.uDust.value = atmos
      u.uAtmos.value = atmos
      u.uDof.value = s.dof ?? 0.7
      this.film.uniforms.uGrain.value = (s.grain ?? 0.5) * 0.06
      this.film.uniforms.uVignette.value = 0.35
      this.film.uniforms.uScan.value = 0
      this.film.uniforms.uAberr.value = 1
      this.synapseMat.uniforms.uCurve.value = 1
    } else if (s.view === 'hologram') {
      const k = s.interference ?? 0.6
      this.dustMat.uniforms.uDust.value = 0.35
      u.uAtmos.value = 0
      u.uDof.value = 0.2
      u.uInterf.value = k
      this.film.uniforms.uGrain.value = 0.012 + k * 0.02
      this.film.uniforms.uVignette.value = 0.45
      this.film.uniforms.uScan.value = k
      this.film.uniforms.uAberr.value = 1 + k * 3
      this.synapseMat.uniforms.uCurve.value = 0.55
      this.grid.visible = s.grid
    } else {
      u.uAtmos.value = 0
      u.uDof.value = 0
      this.synapseMat.uniforms.uCurve.value = 0
    }
    this.synapseMat.uniforms.uOpacity.value = s.linkOpacity * (s.view === 'minimal' ? (light ? 0.95 : 0.75) : 1)
    this.synapseMat.uniforms.uPulses.value = s.pulses ? 1 : 0
    u.uScale.value = this.nodeScale()
    this.labels.setEnabled(s.labels)
    this.invalidate()
  }

  /** Switches shaders, blending and the extra layers (haze, dust, grid, post-processing) to another view. */
  private setLook(view: ViewMode, light: boolean): void {
    if (this.view && (view === 'hologram') !== (this.view === 'hologram')) this.reframe = true
    this.view = view
    this.light = light
    const look = LOOKS[view]
    const bg = backgroundOf(view, light)
    ;(this.uniforms.uBg.value as THREE.Color).set(bg)
    this.uniforms.uLight.value = light ? 1 : 0
    // three encodes the clear colour for the screen even when clearing the linear render target,
    // so pre-linearise it once more to get the exact background after the output pass
    this.renderer.setClearColor(new THREE.Color(bg).convertSRGBToLinear())

    const additive = view !== 'minimal'
    // nebula and minimal: opaque neurons that hide what is behind them; hologram: everything adds light
    this.neuronMat.fragmentShader = look.neuron
    this.neuronMat.transparent = view === 'hologram'
    this.neuronMat.alphaToCoverage = view !== 'hologram'
    this.neuronMat.depthWrite = view !== 'hologram'
    this.neuronMat.blending = view === 'hologram' ? THREE.AdditiveBlending : THREE.NormalBlending
    this.haloMat.fragmentShader = look.halo
    this.haloMat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending
    this.synapseMat.fragmentShader = look.synapse
    this.synapseMat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending
    for (const m of [this.neuronMat, this.haloMat, this.synapseMat]) m.needsUpdate = true

    if (this.hazeMesh) this.hazeMesh.visible = view === 'nebula'
    this.dust.visible = view !== 'minimal'
    this.sky.visible = view !== 'minimal'
    this.grid.visible = view === 'hologram' && this.settings.grid
    if (this.brainMesh) this.brainMesh.visible = view === 'hologram'
    this.bloom.enabled = view !== 'minimal'
    this.film.enabled = view !== 'minimal'
    this.renderer.toneMapping = view === 'minimal' ? THREE.NoToneMapping : THREE.NeutralToneMapping
  }

  /** Effective neuron size: plain discs and the neurons inside the brain read better smaller. */
  private nodeScale(): number {
    return this.settings.nodeScale * (this.view === 'minimal' ? 0.7 : this.view === 'hologram' ? 0.6 : 1)
  }

  /** Recomputes the drawn positions from the layout (warping them into the brain in the hologram view). */
  private updateDisplay(): void {
    if (this.warp > 0 && this.brainFit) {
      warpIntoBrain(this.layoutPositions, this.positions, this.nodes.length, this.brainFit, this.warp)
    } else {
      this.positions.set(this.layoutPositions)
    }
    this.positionsDirty = true
  }

  /** Places the hologram brain around the network, creating it on first use. */
  private placeBrain(): void {
    if (!this.brainFit) return
    if (!this.brainMesh) {
      this.brainMesh = new THREE.Mesh(buildBrainGeometry(), this.brainMat)
      this.brainMesh.renderOrder = 1
      this.brainMesh.frustumCulled = false
      this.root.add(this.brainMesh)
    }
    this.brainMesh.position.copy(this.brainFit.center)
    this.brainMesh.scale.setScalar(this.brainFit.scale)
    this.brainMesh.visible = this.view === 'hologram'
  }

  resetView(): void {
    this.select(null)
    this.flyTo(this.homeTarget(), this.homeOffset(), 1600)
  }

  /** Radius used to frame the overview: the network, or the whole brain in the hologram view. */
  private frameRadius(): number {
    if (this.view === 'hologram' && this.brainFit && this.warp > 0.5) return this.brainFit.scale * 1.05
    return Math.max(this.layoutRadius() * 0.75, 100)
  }

  /** Approximate bounds of the current layout, for camera framing. */
  private layoutRadius(): number {
    let max = 0
    for (let i = 0; i < this.nodes.length; i++) {
      const x = this.positions[i * 3]
      const y = this.positions[i * 3 + 1]
      const z = this.positions[i * 3 + 2]
      max = Math.max(max, x * x + y * y + z * z)
    }
    return Math.sqrt(max)
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    clearTimeout(this.restTimer)
    this.worker.terminate()
    this.renderer.dispose()
  }

  /* --------------------------------------------------------------- building */

  private buildNeurons(): void {
    if (this.neuronMesh) {
      this.root.remove(this.neuronMesh)
      if (this.haloMesh) this.root.remove(this.haloMesh)
      this.neuronMesh.geometry.dispose()
    }
    const n = this.nodes.length
    const geo = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(2, 2)
    geo.index = quad.index
    geo.setAttribute('position', quad.getAttribute('position'))
    const color = new Float32Array(n * 3)
    const size = new Float32Array(n)
    const seed = new Float32Array(n)
    const kind = new Float32Array(n)
    this.nodes.forEach((node, i) => {
      const c = this.colors.get(node.group) ?? new THREE.Color('#ffffff')
      color.set([c.r, c.g, c.b], i * 3)
      size[i] = this.radii[i]
      seed[i] = hashString(node.id)
      kind[i] = KIND_CODE[node.kind]
    })
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage))
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3))
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(size, 1))
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1))
    geo.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1))
    geo.setAttribute('aState', new THREE.InstancedBufferAttribute(new Float32Array(n), 1))
    geo.setAttribute('aVisible', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1))
    geo.instanceCount = n
    this.neuronMesh = new THREE.Mesh(geo, this.neuronMat)
    this.neuronMesh.frustumCulled = false
    this.root.add(this.neuronMesh)
    this.haloMesh = new THREE.Mesh(geo, this.haloMat)
    this.haloMesh.frustumCulled = false
    this.haloMesh.renderOrder = 3
    this.root.add(this.haloMesh)
  }

  private buildSynapses(): void {
    if (this.synapseMesh) {
      this.root.remove(this.synapseMesh)
      this.synapseMesh.geometry.dispose()
    }
    const m = this.links.length
    const geo = new THREE.BufferGeometry()
    const side = new Float32Array(m * VPL)
    const t = new Float32Array(m * VPL)
    const color = new Float32Array(m * VPL * 3)
    const seed = new Float32Array(m * VPL)
    const index = new Uint32Array(m * SEG * 6)
    const mixed = new THREE.Color()
    this.links.forEach(([a, b], k) => {
      const ca = this.colors.get(this.nodes[a].group) ?? new THREE.Color('#fff')
      const cb = this.colors.get(this.nodes[b].group) ?? new THREE.Color('#fff')
      const s = Math.random()
      for (let j = 0; j <= SEG; j++) {
        const u = j / SEG
        mixed.copy(ca).lerp(cb, u) // the thread slowly changes colour between its two regions
        for (let sd = 0; sd < 2; sd++) {
          const vi = k * VPL + j * 2 + sd
          side[vi] = sd === 0 ? -1 : 1
          t[vi] = u
          color.set([mixed.r, mixed.g, mixed.b], vi * 3)
          seed[vi] = s
        }
      }
      for (let j = 0; j < SEG; j++) {
        const o = k * VPL + j * 2
        index.set([o, o + 1, o + 2, o + 2, o + 1, o + 3], (k * SEG + j) * 6)
      }
    })
    const dyn = (arr: Float32Array, size: number): THREE.BufferAttribute =>
      new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aStart', dyn(new Float32Array(m * VPL * 3), 3))
    geo.setAttribute('aEnd', dyn(new Float32Array(m * VPL * 3), 3))
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 1))
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3))
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    geo.setAttribute('aState', dyn(new Float32Array(m * VPL), 1))
    geo.setAttribute('aVisible', dyn(new Float32Array(m * VPL).fill(1), 1))
    // three needs a position attribute to compute draw range
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m * VPL * 3), 3))
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    this.synapseMesh = new THREE.Mesh(geo, this.synapseMat)
    this.synapseMesh.frustumCulled = false
    this.synapseMesh.renderOrder = 2
    this.root.add(this.synapseMesh)
    this.positionsDirty = true
  }

  private syncPositions(): void {
    if (!this.neuronMesh || !this.synapseMesh) return
    ;(this.neuronMesh.geometry.getAttribute('aPos') as THREE.BufferAttribute).needsUpdate = true
    const start = this.synapseMesh.geometry.getAttribute('aStart') as THREE.BufferAttribute
    const end = this.synapseMesh.geometry.getAttribute('aEnd') as THREE.BufferAttribute
    const sa = start.array as Float32Array
    const ea = end.array as Float32Array
    const p = this.positions
    for (let k = 0; k < this.links.length; k++) {
      const a = this.links[k][0] * 3
      const b = this.links[k][1] * 3
      for (let v = 0; v < VPL; v++) {
        const o = (k * VPL + v) * 3
        sa[o] = p[a]
        sa[o + 1] = p[a + 1]
        sa[o + 2] = p[a + 2]
        ea[o] = p[b]
        ea[o + 1] = p[b + 1]
        ea[o + 2] = p[b + 2]
      }
    }
    start.needsUpdate = true
    end.needsUpdate = true
  }

  private applyVisibility(): void {
    if (!this.neuronMesh || !this.synapseMesh) return
    const nv = this.neuronMesh.geometry.getAttribute('aVisible') as THREE.BufferAttribute
    this.nodes.forEach((node, i) => {
      this.visible[i] = this.hiddenGroups.has(node.group) ? 0 : 1
      nv.setX(i, this.visible[i])
    })
    nv.needsUpdate = true
    const lv = this.synapseMesh.geometry.getAttribute('aVisible') as THREE.BufferAttribute
    const arr = lv.array as Float32Array
    this.links.forEach(([a, b], k) => arr.fill(this.visible[a] && this.visible[b] ? 1 : 0, k * VPL, k * VPL + VPL))
    lv.needsUpdate = true
    if (this.selected >= 0 && !this.visible[this.selected]) this.select(null, false)
    this.rebuildHaze()
    this.invalidate()
  }

  private refreshStates(): void {
    if (!this.neuronMesh || !this.synapseMesh) return
    const ns = this.neuronMesh.geometry.getAttribute('aState') as THREE.BufferAttribute
    const ls = this.synapseMesh.geometry.getAttribute('aState') as THREE.BufferAttribute
    const nArr = ns.array as Float32Array
    const lArr = ls.array as Float32Array
    nArr.fill(STATE.idle)
    lArr.fill(0)
    let active = false
    if (this.focusGroup !== null) {
      active = true
      this.nodes.forEach((n, i) => {
        if (n.group === this.focusGroup) nArr[i] = STATE.linked
      })
      this.links.forEach(([a, b], k) => {
        if (this.nodes[a].group === this.focusGroup && this.nodes[b].group === this.focusGroup) lArr.fill(1, k * VPL, k * VPL + VPL)
      })
    } else if (this.selected >= 0) {
      active = true
      for (const j of this.neighbours[this.selected]) nArr[j] = STATE.linked
      nArr[this.selected] = STATE.selected
      this.links.forEach(([a, b], k) => {
        if (a === this.selected || b === this.selected) lArr.fill(1, k * VPL, k * VPL + VPL)
      })
    } else if (this.agentFocus.size) {
      // neurons the AI agent is reading or editing
      active = true
      for (const i of this.agentFocus) nArr[i] = STATE.linked
      this.links.forEach(([a, b], k) => {
        if (this.agentFocus.has(a) && this.agentFocus.has(b)) lArr.fill(1, k * VPL, k * VPL + VPL)
      })
    }
    if (this.hovered >= 0 && this.hovered !== this.selected) nArr[this.hovered] = STATE.hovered
    // hubs with hundreds of highlighted synapses would otherwise turn into a white starburst
    const hlCount =
      this.focusGroup !== null ? 40 : this.selected >= 0 ? this.neighbours[this.selected].length : Math.max(this.agentFocus.size, 1)
    this.synapseMat.uniforms.uHlGain.value = THREE.MathUtils.clamp(2.6 / Math.sqrt(Math.max(hlCount, 1)), 0.2, 1)
    ns.needsUpdate = true
    ls.needsUpdate = true
    this.dimTarget = active ? 1 : 0
    // a hover only needs one new frame; dimming the rest of the network animates (see frame)
    this.invalidate()
  }

  /* ----------------------------------------------------------------- camera */

  private flyTo(target: THREE.Vector3, offset: THREE.Vector3, duration = 1300): void {
    this.flight = {
      fromPos: this.camera.position.clone(),
      toPos: target.clone().add(offset),
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      t0: performance.now(),
      duration
    }
    this.requestActive()
  }

  private nodeWorld(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.fromArray(this.positions, i * 3).applyMatrix4(this.root.matrixWorld)
  }

  flyToNode(i: number): void {
    const target = this.nodeWorld(i)
    // frame the neuron together with its neighbourhood
    const dists = this.neighbours[i].map((j) => this.nodeWorld(j).distanceTo(target)).sort((a, b) => a - b)
    const extent = dists.length ? dists[Math.floor(dists.length * 0.8)] : 0
    const dist = THREE.MathUtils.clamp(extent * (dists.length > 20 ? 2.4 : 1.6), this.radii[i] * 14, 1100)
    const dir = this.camera.position.clone().sub(this.controls.target).normalize()
    if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0, 0, 1)
    this.flyTo(target, dir.multiplyScalar(dist))
  }

  /* ----------------------------------------------------------------- events */

  private bindEvents(): void {
    const el = this.renderer.domElement
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect()
      this.pointer.x = e.clientX - r.left
      this.pointer.y = e.clientY - r.top
      this.pointer.inside = true
      if (this.pointer.down) {
        if (Math.hypot(e.clientX - this.pointer.downX, e.clientY - this.pointer.downY) > 5) this.pointer.moved = true
        this.requestActive(LINGER_MS, true)
      } else {
        // the projected neurons are current while the camera is still: no need to wake the loop to hover
        this.setHovered(this.pick(this.pointer.x, this.pointer.y))
      }
    })
    el.addEventListener('pointerleave', () => {
      this.pointer.inside = false
      this.setHovered(-1)
    })
    el.addEventListener('pointerdown', (e) => {
      this.requestActive(LINGER_MS, true)
      this.pointer.down = true
      this.pointer.moved = false
      this.pointer.downX = e.clientX
      this.pointer.downY = e.clientY
    })
    el.addEventListener('pointerup', () => {
      const wasClick = this.pointer.down && !this.pointer.moved
      this.pointer.down = false
      if (!wasClick) return
      const hit = this.pick(this.pointer.x, this.pointer.y)
      if (hit >= 0) this.select(this.nodes[hit].id)
      else if (this.selected >= 0) this.select(null, false)
    })
    el.addEventListener('wheel', () => {
      this.flight = null
      this.lastInteraction = performance.now()
      this.requestActive(LINGER_MS, true)
    })

    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return
      const k = e.key.toLowerCase()
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
        this.keys.add(k)
        this.flight = null
        this.lastInteraction = performance.now()
        this.requestActive(LINGER_MS, true)
      }
    })
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()))
    window.addEventListener('blur', () => this.keys.clear())
  }

  private setHovered(i: number): void {
    if (i === this.hovered) return
    this.hovered = i
    this.refreshStates()
    this.renderer.domElement.style.cursor = i >= 0 ? 'pointer' : ''
    this.onHover?.(i >= 0 ? this.nodes[i].id : null)
  }

  /** Screen-space picking against the projected neurons (cheap for a few thousand nodes). */
  private pick(x: number, y: number): number {
    let best = -1
    let bestScore = Infinity
    for (let i = 0; i < this.nodes.length; i++) {
      if (!this.visible[i]) continue
      const o = i * 4
      const depth = this.screen[o + 2]
      if (depth <= 0) continue
      const r = Math.max(this.screen[o + 3] * 1.15, 7)
      const d = Math.hypot(this.screen[o] - x, this.screen[o + 1] - y)
      if (d > r) continue
      const score = depth * (0.6 + d / r)
      if (score < bestScore) {
        bestScore = score
        best = i
      }
    }
    return best
  }

  private resize(): void {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = w + 'px'
    this.renderer.domElement.style.height = h + 'px'
    this.composer.setSize(w, h)
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.bloom.resolution.set(w, h)
    this.film.uniforms.uAspect.value = w / h
    this.film.uniforms.uHeight.value = h
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    // resizing clears the canvas: draw again before it is shown, then keep going while the window is dragged
    if (!document.hidden && this.lastFrameAt) {
      this.frame()
      this.lastFrameAt = performance.now()
    }
    this.requestActive()
  }

  /* ---------------------------------------------------------------- worker */

  private onWorker(msg: LayoutOut): void {
    if (msg.positions.length !== this.layoutPositions.length) return
    this.layoutPositions.set(msg.positions)
    if (msg.type === 'done' || !this.brainFit) this.brainFit = fitBrain(this.layoutPositions, this.nodes.length)
    this.updateDisplay()
    this.requestActive()
    if (msg.type === 'done') {
      this.layoutRunning = false
      this.boundsRadius = this.frameRadius()
      this.fitVolume()
      this.rebuildHaze()
      this.onLayout?.(1, true)
    } else {
      this.onLayout?.(msg.progress, false)
    }
  }

  /* ------------------------------------------------------------------ frame */

  private frame(): void {
    this.timer.update()
    // after a pause (rest, hidden window) restart smoothly instead of catching up in one jump
    const dt = Math.min(this.timer.getDelta(), 2 / this.fps)
    const time = this.timer.getElapsed()
    const flying = !!this.flight || this.keys.size > 0
    this.neuronMat.uniforms.uTime.value = time

    if (this.positionsDirty) {
      this.syncPositions()
      this.positionsDirty = false
    }

    // camera flight
    if (this.flight) {
      const f = this.flight
      const t = Math.min((performance.now() - f.t0) / f.duration, 1)
      const k = easeInOutCubic(t)
      this.camera.position.lerpVectors(f.fromPos, f.toPos, k)
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k)
      if (t >= 1) this.flight = null
    }

    // WASD / arrow keys fly through the network
    if (this.keys.size) {
      const fwd = new THREE.Vector3()
      this.camera.getWorldDirection(fwd)
      const right = new THREE.Vector3().crossVectors(fwd, this.camera.up).normalize()
      const up = new THREE.Vector3().crossVectors(right, fwd).normalize()
      const move = new THREE.Vector3()
      const has = (...k: string[]): number => (k.some((x) => this.keys.has(x)) ? 1 : 0)
      move.addScaledVector(fwd, has('w', 'arrowup') - has('s', 'arrowdown'))
      move.addScaledVector(up, has('e') - has('q'))
      move.addScaledVector(right, has('d', 'arrowright') - has('a', 'arrowleft'))
      if (move.lengthSq() > 0) {
        const dist = this.camera.position.distanceTo(this.controls.target)
        const speed = THREE.MathUtils.clamp(dist * 0.8, 40, 2000) * (this.keys.has('shift') ? 3 : 1)
        move.normalize().multiplyScalar(speed * dt)
        this.camera.position.add(move)
        this.controls.target.add(move)
      }
    }

    const idle = performance.now() - this.lastInteraction > 4000
    // only while the window has focus: in the background the loop rests
    this.controls.autoRotate = this.settings.autoRotate && this.focused && this.selected < 0 && !this.flight && idle
    // the same inertia in seconds whatever the frame rate
    this.controls.dampingFactor = 1 - Math.pow(1 - DAMPING, dt * 60)
    const orbiting = this.controls.update(dt)

    // hologram: the network flows into the brain (and back out when leaving the view)
    const warpTarget = this.view === 'hologram' ? 1 : 0
    const warping = this.warp !== warpTarget
    if (warping) {
      this.warp = THREE.MathUtils.clamp(this.warp + Math.sign(warpTarget - this.warp) * dt / 1.4, 0, 1)
      this.updateDisplay()
      this.boundsRadius = this.frameRadius()
      this.fitVolume()
      if (this.warp === warpTarget && this.reframe) {
        this.reframe = false
        if (this.selected >= 0) this.flyToNode(this.selected)
        else this.flyTo(this.homeTarget(), this.homeOffset(), 1400)
      }
    } else if (this.warp > 0 && this.layoutRunning) {
      this.brainFit = fitBrain(this.layoutPositions, this.nodes.length)
    }
    if (this.view === 'hologram') this.placeBrain()

    // fog distance follows the zoom level
    const camDist = this.camera.position.distanceTo(this.controls.target)
    if (this.view === 'hologram' && this.brainFit) {
      // getting closer than the brain is big: the shell fades away and the neurons come forward
      const size = this.brainFit.scale
      const reveal = 1 - THREE.MathUtils.smoothstep(camDist, size * 1.2, size * 3.4)
      this.uniforms.uReveal.value = reveal
      const shell = (1 - reveal) * this.warp
      this.brainMat.uniforms.uShell.value = shell
      // a faded shell would still be drawn over the whole screen (twice): skip it
      if (this.brainMesh) this.brainMesh.visible = shell > 0.02
      this.synapseMat.uniforms.uOpacity.value = this.settings.linkOpacity * THREE.MathUtils.lerp(0.3, 0.9, reveal)
    }
    const u = this.neuronMat.uniforms
    // depth fog scales with the zoom: from inside a cluster its far side recedes into the dark
    u.uFogNear.value = camDist * 1.5 + this.boundsRadius * 0.15
    u.uFogFar.value = camDist * 4 + this.boundsRadius * 1.6
    u.uPixelScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this.container.clientHeight
    const dimming = Math.abs(this.dimTarget - u.uDim.value) > 0.002
    u.uDim.value = dimming ? u.uDim.value + (this.dimTarget - u.uDim.value) * Math.min(1, dt * 5) : this.dimTarget
    this.synapseMat.uniforms.uWidth.value = 0.14 * this.settings.nodeScale

    // a touch of bloom on highlights only, weaker when inside a dense cluster
    const zoomOut = THREE.MathUtils.smoothstep(camDist / this.boundsRadius, 0.15, 1.8)
    this.bloom.strength = (this.view === 'hologram' ? 0.24 : 0.3) * this.settings.bloom * THREE.MathUtils.lerp(0.3, 1, zoomOut)

    this.sky.position.copy(this.camera.position)
    this.dust.rotation.y = time * 0.002
    u.uFocus.value = camDist
    this.film.uniforms.uTime.value = time
    if (this.layoutRunning && performance.now() - this.lastHaze > 900) {
      this.lastHaze = performance.now()
      this.boundsRadius = this.frameRadius()
      this.fitVolume()
      this.rebuildHaze()
    }

    this.projectNodes()
    if (this.pointer.inside && !this.pointer.down) this.setHovered(this.pick(this.pointer.x, this.pointer.y))
    this.labels.update(this, this.screen, this.visible, this.radii)

    this.composer.render(dt)

    // everything that moves the scene keeps the full frame rate (shader effects alone do not)
    if (flying || orbiting || warping || dimming || this.pointer.down || this.layoutRunning || this.controls.autoRotate) {
      this.activeUntil = Math.max(this.activeUntil, performance.now() + LINGER_MS)
    }
  }

  private projectNodes(): void {
    this.root.updateMatrixWorld()
    this.camera.updateMatrixWorld()
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.projMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.root.matrixWorld)
    const e = this.projMatrix.elements
    const pixelScale = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / h
    const scale = this.nodeScale()
    const p = this.positions
    for (let i = 0; i < this.nodes.length; i++) {
      const x = p[i * 3]
      const y = p[i * 3 + 1]
      const z = p[i * 3 + 2]
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15]
      const o = i * 4
      if (cw <= 0.5) {
        this.screen[o + 2] = -1
        continue
      }
      const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw
      const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw
      this.screen[o] = (cx * 0.5 + 0.5) * w
      this.screen[o + 1] = (-cy * 0.5 + 0.5) * h
      this.screen[o + 2] = cw
      this.screen[o + 3] = (this.radii[i] * scale) / (cw * pixelScale)
    }
  }

  /** Used by the label layer. */
  stateOf(i: number): 'selected' | 'hovered' | 'linked' | 'dimmed' | 'idle' {
    if (i === this.selected) return 'selected'
    if (i === this.hovered) return 'hovered'
    if (this.dimTarget > 0) {
      if (this.focusGroup !== null) return this.nodes[i].group === this.focusGroup ? 'linked' : 'dimmed'
      if (this.selected >= 0) return this.neighbours[this.selected]?.includes(i) ? 'linked' : 'dimmed'
      return this.agentFocus.has(i) ? 'linked' : 'dimmed'
    }
    return 'idle'
  }

  degreeOf(i: number): number {
    return this.neighbours[i]?.length ?? 0
  }

  private cssColors = new Map<string, string>()
  cssColorOf(i: number): string {
    const group = this.nodes[i].group
    let css = this.cssColors.get(group)
    if (!css) {
      css = '#' + (this.colors.get(group)?.getHexString() ?? 'ffffff')
      this.cssColors.set(group, css)
    }
    return css
  }

  get isLayoutRunning(): boolean {
    return this.layoutRunning
  }
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}
