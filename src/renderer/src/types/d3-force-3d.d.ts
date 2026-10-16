declare module 'd3-force-3d' {
  export interface SimNode {
    index?: number
    x?: number
    y?: number
    z?: number
    vx?: number
    vy?: number
    vz?: number
    fx?: number | null
    fy?: number | null
    fz?: number | null
    [key: string]: unknown
  }
  export interface SimLink<N extends SimNode = SimNode> {
    source: number | N
    target: number | N
    index?: number
  }
  type Accessor<T, R> = R | ((d: T, i: number, data: T[]) => R)

  export interface Force<N extends SimNode = SimNode> {
    (alpha: number): void
    initialize?(nodes: N[], ...args: unknown[]): void
  }
  export interface Simulation<N extends SimNode = SimNode> {
    tick(iterations?: number): this
    stop(): this
    restart(): this
    alpha(): number
    alpha(a: number): this
    alphaMin(): number
    alphaMin(a: number): this
    alphaDecay(): number
    alphaDecay(a: number): this
    alphaTarget(a: number): this
    velocityDecay(a: number): this
    nodes(): N[]
    nodes(n: N[]): this
    force(name: string): Force<N> | undefined
    force(name: string, f: Force<N> | null): this
    on(type: string, listener: (() => void) | null): this
  }
  export function forceSimulation<N extends SimNode>(nodes?: N[], numDimensions?: number): Simulation<N>

  export interface LinkForce<N extends SimNode, L extends SimLink<N>> extends Force<N> {
    links(l: L[]): this
    distance(d: Accessor<L, number>): this
    strength(s: Accessor<L, number>): this
    iterations(n: number): this
  }
  export function forceLink<N extends SimNode, L extends SimLink<N>>(links?: L[]): LinkForce<N, L>

  export interface ManyBodyForce<N extends SimNode> extends Force<N> {
    strength(s: Accessor<N, number>): this
    theta(t: number): this
    distanceMin(d: number): this
    distanceMax(d: number): this
  }
  export function forceManyBody<N extends SimNode>(): ManyBodyForce<N>

  export interface PositionForce<N extends SimNode> extends Force<N> {
    strength(s: Accessor<N, number>): this
  }
  export function forceX<N extends SimNode>(x?: Accessor<N, number>): PositionForce<N>
  export function forceY<N extends SimNode>(y?: Accessor<N, number>): PositionForce<N>
  export function forceZ<N extends SimNode>(z?: Accessor<N, number>): PositionForce<N>
  export function forceCenter<N extends SimNode>(x?: number, y?: number, z?: number): Force<N>
}
