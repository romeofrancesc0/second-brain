import type { ViewMode } from '@shared/types'
import { VIEWS } from '../graph/views'
import { icons } from './icons'

/** Floating toolbar at the bottom: switch view, zoom, back to the overview. */
export class Dock {
  onView?: (view: ViewMode) => void
  onZoom?: (factor: number) => void
  onHome?: () => void

  constructor(private el: HTMLElement) {
    el.innerHTML = `
      <div class="seg" role="tablist" aria-label="Vista">
        <span class="seg-thumb"></span>
        ${VIEWS.map(
          (v) => `<button role="tab" data-view="${v.id}" title="${v.name} — ${v.tagline} (${v.key})">${icons[v.id]}<span>${v.name}</span></button>`
        ).join('')}
      </div>
      <span class="dock-sep"></span>
      <button class="dock-btn" data-act="out" title="Allontana (−)">${icons.zoomOut}</button>
      <button class="dock-btn" data-act="home" title="Vista d’insieme (H)">${icons.fit}</button>
      <button class="dock-btn" data-act="in" title="Avvicina (+)">${icons.zoomIn}</button>`
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement
      const view = t.closest<HTMLElement>('[data-view]')?.dataset.view as ViewMode | undefined
      if (view) return this.onView?.(view)
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
      if (act === 'in') this.onZoom?.(0.7)
      else if (act === 'out') this.onZoom?.(1 / 0.7)
      else if (act === 'home') this.onHome?.()
    })
  }

  setView(view: ViewMode): void {
    const buttons = [...this.el.querySelectorAll<HTMLElement>('[data-view]')]
    const active = buttons.find((b) => b.dataset.view === view)
    buttons.forEach((b) => {
      b.classList.toggle('active', b === active)
      b.setAttribute('aria-selected', String(b === active))
    })
    // the highlight slides under the active segment
    const thumb = this.el.querySelector<HTMLElement>('.seg-thumb')!
    requestAnimationFrame(() => {
      if (!active) return
      thumb.style.width = `${active.offsetWidth}px`
      thumb.style.transform = `translateX(${active.offsetLeft}px)`
    })
  }
}
