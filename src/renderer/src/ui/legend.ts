import { icons } from './icons'

export interface LegendGroup {
  name: string
  count: number
  color: string
}

/** "Regioni" list: one entry per corso/area. Click hides, Alt-click isolates, hover highlights. */
export class Legend {
  onChange?: (hidden: Set<string>) => void
  onFocus?: (group: string | null) => void
  private hidden = new Set<string>()
  private groups: LegendGroup[] = []
  private collapsed = false

  constructor(private el: HTMLElement) {
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-action=toggle-collapse]')) {
        this.collapsed = !this.collapsed
        this.el.classList.toggle('collapsed', this.collapsed)
        return
      }
      if (t.closest('[data-action=show-all]')) {
        this.hidden.clear()
        this.emit()
        return
      }
      const row = t.closest<HTMLElement>('li[data-group]')
      if (!row) return
      const g = row.dataset.group!
      if (e.altKey) {
        const onlyThis = this.groups.every((x) => (x.name === g) !== this.hidden.has(x.name))
        this.hidden = onlyThis ? new Set() : new Set(this.groups.map((x) => x.name).filter((x) => x !== g))
      } else if (this.hidden.has(g)) this.hidden.delete(g)
      else this.hidden.add(g)
      this.emit()
    })
    el.addEventListener('mouseover', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('li[data-group]')
      this.onFocus?.(row && !this.hidden.has(row.dataset.group!) ? row.dataset.group! : null)
    })
    el.addEventListener('mouseleave', () => this.onFocus?.(null))
  }

  render(groups: LegendGroup[]): void {
    this.groups = groups
    for (const g of [...this.hidden]) if (!groups.some((x) => x.name === g)) this.hidden.delete(g)
    this.paint()
  }

  private emit(): void {
    this.paint()
    this.onChange?.(new Set(this.hidden))
  }

  private paint(): void {
    const total = this.groups.reduce((s, g) => s + g.count, 0)
    this.el.innerHTML = `
      <div class="legend-head" data-action="toggle-collapse">
        <span>Regioni</span><span class="count">${this.groups.length}</span>
        <span class="chev">${icons.chevron}</span>
      </div>
      <ul>
        ${this.groups
          .map(
            (g) => `<li data-group="${esc(g.name)}" class="${this.hidden.has(g.name) ? 'off' : ''}" title="${esc(g.name)} — click per nascondere, ⌥ click per isolare">
              <i style="--c:${g.color}"></i><span class="name">${esc(g.name)}</span>
              <span class="bar"><b style="width:${Math.max(4, (g.count / Math.max(1, this.groups[0]?.count ?? 1)) * 100)}%;--c:${g.color}"></b></span>
              <span class="n">${g.count}</span></li>`
          )
          .join('')}
      </ul>
      ${this.hidden.size ? `<button class="link-btn" data-action="show-all">Mostra tutte (${this.hidden.size} nascoste)</button>` : `<div class="legend-foot">${total.toLocaleString('it-IT')} elementi · ⌥ click per isolare</div>`}`
    this.el.classList.toggle('collapsed', this.collapsed)
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
