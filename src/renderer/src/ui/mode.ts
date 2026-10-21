import { MODES, type AppMode } from '@shared/types'
import { icons } from './icons'

const ICON: Record<AppMode, string> = { basic: icons.bolt, eco: icons.leaf }

/** The mode button in the title bar and its menu: one entry per mode in MODES, with what each one limits. */
export class ModeMenu {
  onChange?: (mode: AppMode) => void
  private mode: AppMode = 'basic'

  constructor(
    private button: HTMLButtonElement,
    private menu: HTMLElement
  ) {
    button.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggle()
    })
    menu.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode as AppMode | undefined
      if (!id) return
      this.close()
      if (id !== this.mode) this.onChange?.(id)
    })
    window.addEventListener('mousedown', (e) => {
      if (this.isOpen && !menu.contains(e.target as Node) && !button.contains(e.target as Node)) this.close()
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close()
    })
    window.addEventListener('resize', () => this.close())
  }

  get isOpen(): boolean {
    return !this.menu.classList.contains('hidden')
  }

  set(mode: AppMode): void {
    this.mode = mode
    const m = MODES.find((x) => x.id === mode)!
    this.button.innerHTML = `${ICON[mode]}<span>${m.label}</span>`
    this.button.classList.toggle('eco', mode === 'eco')
    this.button.title = [`Modalità ${m.label}: ${m.summary}`, ...m.limits.map((l) => `• ${l}`)].join('\n')
    if (this.isOpen) this.paint()
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  open(): void {
    this.paint()
    const r = this.button.getBoundingClientRect()
    this.menu.style.top = `${r.bottom + 8}px`
    this.menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`
    this.menu.classList.remove('hidden')
    this.button.classList.add('active')
  }

  close(): void {
    this.menu.classList.add('hidden')
    this.button.classList.remove('active')
  }

  private paint(): void {
    this.menu.innerHTML = `
      <div class="mode-title">Modalità</div>
      ${MODES.map(
        (m) => `<button class="mode-item ${m.id === this.mode ? 'on' : ''}" data-mode="${m.id}" aria-pressed="${m.id === this.mode}">
          <span class="mode-ic">${ICON[m.id]}</span>
          <span class="mode-text"><b>${m.label}</b><small>${m.summary}</small>${
            m.limits.length ? `<ul>${m.limits.map((l) => `<li>${l}</li>`).join('')}</ul>` : ''
          }</span>
          <span class="mode-check">${icons.check}</span>
        </button>`
      ).join('')}`
  }
}
