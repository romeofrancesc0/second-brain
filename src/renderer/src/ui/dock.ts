import { icons } from './icons'

/** Small floating toolbar at the bottom: zoom out, back to the overview, zoom in. */
export class Dock {
  onZoom?: (factor: number) => void
  onHome?: () => void

  constructor(private el: HTMLElement) {
    el.innerHTML = `
      <button class="dock-btn" data-act="out" title="Allontana (−)">${icons.zoomOut}</button>
      <button class="dock-btn" data-act="home" title="Vista d’insieme (H)">${icons.fit}</button>
      <button class="dock-btn" data-act="in" title="Avvicina (+)">${icons.zoomIn}</button>`
    el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('.dock-btn')?.dataset.act
      if (act === 'in') this.onZoom?.(0.7)
      else if (act === 'out') this.onZoom?.(1 / 0.7)
      else if (act === 'home') this.onHome?.()
    })
  }
}
