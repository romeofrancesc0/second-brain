import type { AppSettings } from '@shared/types'
import { icons } from './icons'

type BoolKey = { [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never }[keyof AppSettings]
type NumKey = { [K in keyof AppSettings]: AppSettings[K] extends number ? K : never }[keyof AppSettings]

const SLIDERS: { key: NumKey; label: string; min: number; max: number; step: number }[] = [
  { key: 'atmosphere', label: 'Atmosfera (nebbia e polvere)', min: 0, max: 2, step: 0.05 },
  { key: 'dof', label: 'Profondità di campo', min: 0, max: 1.5, step: 0.05 },
  { key: 'grain', label: 'Grana', min: 0, max: 1.5, step: 0.05 },
  { key: 'bloom', label: 'Bagliore', min: 0, max: 2.5, step: 0.05 },
  { key: 'linkOpacity', label: 'Intensità sinapsi', min: 0.1, max: 3, step: 0.05 },
  { key: 'nodeScale', label: 'Dimensione neuroni', min: 0.4, max: 2.5, step: 0.05 }
]

const TOGGLES: { key: BoolKey; label: string; hint?: string; structural?: boolean }[] = [
  { key: 'labels', label: 'Etichette' },
  { key: 'pulses', label: 'Impulsi sulle sinapsi' },
  { key: 'autoRotate', label: 'Rotazione automatica' },
  { key: 'showAttachments', label: 'Fonti (PDF, immagini…)', structural: true },
  { key: 'showUnresolved', label: 'Collegamenti non risolti', structural: true },
  { key: 'showOrphans', label: 'Neuroni isolati', structural: true }
]

export class SettingsPopover {
  onChange?: (s: AppSettings, structural: boolean) => void
  onRelayout?: () => void
  onChangeVault?: () => void

  constructor(
    private el: HTMLElement,
    private settings: AppSettings
  ) {
    this.paint()
    el.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement
      const key = input.dataset.key as keyof AppSettings | undefined
      if (!key) return
      if (input.type === 'range') {
        ;(this.settings[key as NumKey] as number) = Number(input.value)
        const out = el.querySelector(`[data-out="${key}"]`)
        if (out) out.textContent = Number(input.value).toFixed(2)
        this.onChange?.({ ...this.settings }, false)
      } else {
        ;(this.settings[key as BoolKey] as boolean) = input.checked
        this.onChange?.({ ...this.settings }, !!TOGGLES.find((t) => t.key === key)?.structural)
      }
    })
    el.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action
      if (action === 'relayout') this.onRelayout?.()
      if (action === 'vault') this.onChangeVault?.()
    })
  }

  toggle(): void {
    this.el.classList.toggle('hidden')
  }

  hide(): void {
    this.el.classList.add('hidden')
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden')
  }

  private paint(): void {
    this.el.innerHTML = `
      <h4>Aspetto</h4>
      ${SLIDERS.map(
        (s) => `<label class="slider"><span>${s.label}<output data-out="${s.key}">${this.settings[s.key].toFixed(2)}</output></span>
          <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${this.settings[s.key]}" /></label>`
      ).join('')}
      <h4>Mostra</h4>
      ${TOGGLES.map(
        (t) => `<label class="toggle"><span>${t.label}</span><input type="checkbox" data-key="${t.key}" ${this.settings[t.key] ? 'checked' : ''} /><i></i></label>`
      ).join('')}
      <div class="settings-actions">
        <button class="btn ghost" data-action="relayout">${icons.refresh}Ricalcola layout</button>
        <button class="btn ghost" data-action="vault">${icons.vault}Cambia vault</button>
      </div>`
  }
}
