import { t } from '@shared/i18n'
import type { GraphNode } from '@shared/types'
import { icons } from './icons'

interface Entry {
  node: GraphNode
  title: string
  extra: string
}

const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** ⌘K command palette to jump to any neuron. */
export class SearchPalette {
  onPick?: (id: string) => void
  private entries: Entry[] = []
  private results: Entry[] = []
  private active = 0
  private input: HTMLInputElement
  private list: HTMLElement
  private colorOf: (n: GraphNode) => string = () => '#fff'

  constructor(private root: HTMLElement) {
    root.innerHTML = `
      <div class="palette glass">
        <div class="palette-input">${icons.search}<input type="text" placeholder="${t('Cerca tra i neuroni, i corsi, i tag…')}" spellcheck="false" /><kbd>esc</kbd></div>
        <ul class="palette-results"></ul>
        <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> naviga</span><span><kbd>↵</kbd> vola al neurone</span></div>
      </div>`
    this.input = root.querySelector('input')!
    this.list = root.querySelector('.palette-results')!
    this.input.addEventListener('input', () => this.search())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') this.move(1)
      else if (e.key === 'ArrowUp') this.move(-1)
      else if (e.key === 'Enter') this.pick(this.active)
      else if (e.key === 'Escape') this.close()
      else return
      e.preventDefault()
    })
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) this.close()
    })
    this.list.addEventListener('click', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]')
      if (li) this.pick(Number(li.dataset.i))
    })
    this.list.addEventListener('mousemove', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]')
      if (li && Number(li.dataset.i) !== this.active) {
        this.active = Number(li.dataset.i)
        this.paintActive()
      }
    })
  }

  setNodes(nodes: GraphNode[], colorOf: (n: GraphNode) => string): void {
    this.colorOf = colorOf
    this.entries = nodes.map((node) => ({
      node,
      title: normalize(node.title),
      extra: normalize([node.group, node.corso ?? '', ...node.tags].join(' '))
    }))
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden')
  }

  open(): void {
    this.root.classList.remove('hidden')
    this.input.value = ''
    this.search()
    requestAnimationFrame(() => this.input.focus())
  }

  close(): void {
    this.root.classList.add('hidden')
    this.input.blur()
  }

  private search(): void {
    const q = normalize(this.input.value.trim())
    if (!q) {
      // most connected notes first when the query is empty
      this.results = this.entries.filter((e) => e.node.kind === 'moc').slice(0, 40)
    } else {
      const tokens = q.split(/\s+/)
      const scored: [Entry, number][] = []
      for (const e of this.entries) {
        let score = -1
        const idx = e.title.indexOf(q)
        if (e.title === q) score = 0
        else if (idx === 0) score = 1
        else if (idx > 0) score = 2 + idx / 100
        else if (tokens.every((t) => e.title.includes(t))) score = 3
        else if (tokens.every((t) => e.title.includes(t) || e.extra.includes(t))) score = 4
        else if (subsequence(q, e.title)) score = 5
        if (score < 0) continue
        if (e.node.kind === 'moc') score -= 0.5
        if (e.node.kind === 'attachment') score += 0.6
        scored.push([e, score + e.title.length / 1000])
      }
      scored.sort((a, b) => a[1] - b[1])
      this.results = scored.slice(0, 60).map(([e]) => e)
    }
    this.active = 0
    this.render()
  }

  private render(): void {
    if (!this.results.length) {
      this.list.innerHTML = `<li class="empty">${t('Nessun neurone trovato')}</li>`
      return
    }
    this.list.innerHTML = this.results
      .map((e, i) => {
        const n = e.node
        const sub = n.kind === 'attachment' ? t('Fonte') + ' · ' + n.group : n.kind === 'moc' ? t('Mappa dei contenuti') : n.group
        return `<li data-i="${i}"><i style="--c:${this.colorOf(n)}"></i><span class="r-title">${esc(n.title)}</span><span class="r-sub">${esc(sub)}</span></li>`
      })
      .join('')
    this.paintActive()
  }

  private paintActive(): void {
    this.list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i === this.active))
    this.list.querySelector('li.active')?.scrollIntoView({ block: 'nearest' })
  }

  private move(d: number): void {
    if (!this.results.length) return
    this.active = (this.active + d + this.results.length) % this.results.length
    this.paintActive()
  }

  private pick(i: number): void {
    const e = this.results[i]
    if (!e) return
    this.close()
    this.onPick?.(e.node.id)
  }
}

function subsequence(q: string, s: string): boolean {
  if (q.length < 3) return false
  let j = 0
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) j++
  return j === q.length
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
