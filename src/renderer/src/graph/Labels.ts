import type { Brain } from './Brain'

const MAX_LABELS = 45

interface Slot {
  el: HTMLDivElement
  title: HTMLSpanElement
  sub: HTMLSpanElement
  node: number
}

interface Candidate {
  i: number
  score: number
  r: number
  state: ReturnType<Brain['stateOf']>
}

/** HTML labels that follow the neurons: the closer you get, the more names appear. */
export class Labels {
  private slots: Slot[] = []
  private enabled = true
  private rects: number[] = []

  constructor(private layer: HTMLElement) {
    for (let i = 0; i < MAX_LABELS; i++) {
      const el = document.createElement('div')
      el.className = 'node-label'
      const title = document.createElement('span')
      title.className = 't'
      const sub = document.createElement('span')
      sub.className = 's'
      el.append(title, sub)
      layer.appendChild(el)
      this.slots.push({ el, title, sub, node: -1 })
    }
  }

  setEnabled(v: boolean): void {
    this.enabled = v
  }

  update(brain: Brain, screen: Float32Array, visible: Uint8Array, radii: Float32Array): void {
    const w = this.layer.clientWidth
    const h = this.layer.clientHeight
    const candidates: Candidate[] = []
    const n = brain.nodes.length
    for (let i = 0; i < n; i++) {
      if (!visible[i]) continue
      const o = i * 4
      if (screen[o + 2] <= 0) continue
      const x = screen[o]
      const y = screen[o + 1]
      if (x < -60 || x > w + 60 || y < -30 || y > h + 30) continue
      const state = brain.stateOf(i)
      if (state === 'dimmed') continue
      const r = screen[o + 3]
      const kind = brain.nodes[i].kind
      const isHub = kind === 'moc'
      let score = r * (isHub ? 2.6 : 1)
      if (state === 'selected') score += 1e6
      else if (state === 'hovered') score += 1e5
      else if (state === 'linked') score += 50
      const show =
        state === 'selected' ||
        state === 'hovered' ||
        (state === 'linked' && r > 1.6) ||
        (isHub && r > 1.6) ||
        r > (kind === 'attachment' ? 7 : 5)
      if (!this.enabled && state !== 'selected' && state !== 'hovered') continue
      if (show) candidates.push({ i, score, r, state })
    }
    candidates.sort((a, b) => b.score - a.score)

    this.rects.length = 0
    let used = 0
    for (const c of candidates) {
      if (used >= MAX_LABELS) break
      const node = brain.nodes[c.i]
      const o = c.i * 4
      const big = node.kind === 'moc' || c.state === 'selected'
      const text = node.title.length > 44 ? node.title.slice(0, 42) + '…' : node.title
      const lw = text.length * (big ? 7.4 : 6.4) + 12
      const lh = c.state === 'selected' || c.state === 'hovered' ? 34 : 18
      const x = screen[o]
      const rich = c.state === 'selected' || c.state === 'hovered'
      const y = screen[o + 1] + Math.max(c.r, 2) * (rich ? 1.5 : 1) + (rich ? 10 : 5)
      const x0 = x - lw / 2
      if (c.state !== 'selected' && c.state !== 'hovered' && this.overlaps(x0, y, lw, lh)) continue
      this.rects.push(x0, y, lw, lh)

      const slot = this.slots[used++]
      if (slot.node !== c.i) {
        slot.node = c.i
        slot.title.textContent = text
        slot.el.className = 'node-label' + (node.kind === 'moc' ? ' hub' : '') + (node.kind === 'attachment' ? ' file' : '')
      }
      slot.el.classList.toggle('rich', rich)
      slot.el.classList.toggle('linked', c.state === 'linked')
      const sub = rich ? `${node.group} · ${brain.degreeOf(c.i)} collegamenti` : ''
      if (slot.sub.textContent !== sub) slot.sub.textContent = sub
      let opacity = 1
      if (!rich && c.state !== 'linked') {
        opacity = node.kind === 'moc' ? smoothstep(1.6, 4, c.r) : smoothstep(5, 11, c.r)
      }
      slot.el.style.opacity = String(Math.max(opacity, 0.0))
      slot.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translateX(-50%)`
      slot.el.style.setProperty('--c', brain.cssColorOf(c.i))
    }
    for (let k = used; k < this.slots.length; k++) {
      const slot = this.slots[k]
      if (slot.node !== -1) {
        slot.node = -1
        slot.el.style.opacity = '0'
      }
    }
  }

  private overlaps(x: number, y: number, w: number, h: number): boolean {
    const r = this.rects
    for (let k = 0; k < r.length; k += 4) {
      if (x < r[k] + r[k + 2] && x + w > r[k] && y < r[k + 1] + r[k + 3] && y + h > r[k + 1]) return true
    }
    return false
  }
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
