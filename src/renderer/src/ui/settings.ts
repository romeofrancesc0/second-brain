import { DEFAULT_SETTINGS, type AppSettings, type Tone, type ViewMode } from '@shared/types'
import { VIEWS, isLight } from '../graph/views'
import { icons } from './icons'

type BoolKey = { [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never }[keyof AppSettings]
type NumKey = { [K in keyof AppSettings]: AppSettings[K] extends number ? K : never }[keyof AppSettings]

type Section = 'theme' | 'graph' | 'motion' | 'vault' | 'agent' | 'keys'

const SECTIONS: { id: Section; label: string; icon: string; lead: string }[] = [
  { id: 'theme', label: 'Tema', icon: icons.palette, lead: 'Scegli come disegnare il grafo e personalizza l’aspetto di ogni vista.' },
  { id: 'graph', label: 'Grafo', icon: icons.graph, lead: 'Cosa mostrare nella rete e quanto devono risaltare neuroni e sinapsi.' },
  { id: 'motion', label: 'Navigazione', icon: icons.move, lead: 'Movimento della camera e aiuti a schermo.' },
  { id: 'vault', label: 'Vault', icon: icons.vault, lead: 'Il vault Obsidian aperto e il suo layout.' },
  { id: 'agent', label: 'Agente AI', icon: icons.agent, lead: 'Modello locale, ricerca semantica e accesso MCP.' },
  { id: 'keys', label: 'Scorciatoie', icon: icons.keyboard, lead: 'Tutti i comandi da tastiera.' }
]

interface SliderDef {
  key: NumKey
  label: string
  hint?: string
  min: number
  max: number
  step: number
}

interface ToggleDef {
  key: BoolKey
  label: string
  hint?: string
  /** Changes which nodes exist, so the graph must be rebuilt. */
  structural?: boolean
}

/** Options that only make sense for one view, shown under "Aspetto". */
const VIEW_SLIDERS: Record<ViewMode, SliderDef[]> = {
  nebula: [
    { key: 'atmosphere', label: 'Atmosfera', hint: 'Nebbia colorata, polvere e bokeh', min: 0, max: 2, step: 0.05 },
    { key: 'dof', label: 'Profondità di campo', hint: 'Sfoca i neuroni lontani dal fuoco', min: 0, max: 1.5, step: 0.05 },
    { key: 'grain', label: 'Grana', hint: 'Grana da pellicola', min: 0, max: 1.5, step: 0.05 },
    { key: 'bloom', label: 'Bagliore', min: 0, max: 2.5, step: 0.05 }
  ],
  minimal: [],
  hologram: [
    { key: 'interference', label: 'Interferenze', hint: 'Scanline, sfarfallio e aberrazione cromatica', min: 0, max: 1.5, step: 0.05 },
    { key: 'bloom', label: 'Bagliore', min: 0, max: 2.5, step: 0.05 }
  ]
}

const VIEW_TOGGLES: Record<ViewMode, ToggleDef[]> = {
  nebula: [],
  minimal: [{ key: 'flat', label: 'Mappa 2D', hint: 'Distende la rete su un piano: si sposta trascinando, senza rotazione' }],
  hologram: [{ key: 'grid', label: 'Griglia di proiezione', hint: 'Il piano luminoso sotto la rete' }]
}

const GRAPH_SLIDERS: SliderDef[] = [
  { key: 'nodeScale', label: 'Dimensione neuroni', min: 0.4, max: 2.5, step: 0.05 },
  { key: 'linkOpacity', label: 'Intensità sinapsi', min: 0.1, max: 3, step: 0.05 }
]

const GRAPH_TOGGLES: ToggleDef[] = [
  { key: 'labels', label: 'Etichette', hint: 'I nomi compaiono man mano che ti avvicini' },
  { key: 'pulses', label: 'Impulsi sulle sinapsi', hint: 'Piccoli lampi che viaggiano lungo i collegamenti' }
]

const CONTENT_TOGGLES: ToggleDef[] = [
  { key: 'showAttachments', label: 'Fonti', hint: 'PDF, immagini e altri file collegati', structural: true },
  { key: 'showUnresolved', label: 'Collegamenti non risolti', hint: 'Note citate ma non ancora create', structural: true },
  { key: 'showOrphans', label: 'Neuroni isolati', hint: 'Note senza collegamenti', structural: true }
]

const MOTION_TOGGLES: ToggleDef[] = [
  { key: 'autoRotate', label: 'Rotazione automatica', hint: 'Dopo qualche secondo di inattività (solo nelle viste 3D)' },
  { key: 'hints', label: 'Suggerimenti dei comandi', hint: 'La riga di aiuto in basso all’avvio' }
]

const ACCENTS: { color: string; name: string }[] = [
  { color: '#8796d6', name: 'Indaco' },
  { color: '#6fb5a8', name: 'Salvia' },
  { color: '#7aa6d6', name: 'Cielo' },
  { color: '#a88be0', name: 'Viola' },
  { color: '#d38aa6', name: 'Rosa' },
  { color: '#d8a868', name: 'Ambra' }
]

const TONES: { id: Tone; label: string; icon: string }[] = [
  { id: 'light', label: 'Chiaro', icon: icons.sun },
  { id: 'dark', label: 'Scuro', icon: icons.moon },
  { id: 'system', label: 'Sistema', icon: icons.monitor }
]

/** Keys that belong to the look of each view, restored by "Ripristina". */
const VIEW_KEYS: Record<ViewMode, (keyof AppSettings)[]> = {
  nebula: ['atmosphere', 'dof', 'grain', 'bloom'],
  minimal: ['tone', 'flat'],
  hologram: ['interference', 'bloom', 'grid']
}

const mod = document.documentElement.dataset.platform === 'mac' ? '⌘' : 'Ctrl'
const SHORTCUTS: { group: string; keys: [string, string][] }[] = [
  {
    group: 'Generale',
    keys: [
      [`${mod} K`, 'Cerca un neurone'],
      ['/', 'Cerca un neurone'],
      [`${mod} J`, 'Apri o chiudi l’agente'],
      [`${mod} ,`, 'Impostazioni'],
      ['?', 'Questa lista'],
      ['Esc', 'Chiudi / deseleziona']
    ]
  },
  {
    group: 'Viste',
    keys: [
      ['1', 'Nebulosa'],
      ['2', 'Minimal'],
      ['3', 'Ologramma']
    ]
  },
  {
    group: 'Camera',
    keys: [
      ['H', 'Vista d’insieme'],
      ['F', 'Inquadra il neurone selezionato'],
      ['W A S D', 'Vola (in 2D: sposta)'],
      ['Q E', 'Scendi / sali (in 2D: zoom)'],
      ['Shift', 'Più veloce'],
      ['+  −', 'Zoom']
    ]
  }
]

/** Full settings window: a sidebar of sections and grouped, card-style rows. */
export class SettingsDialog {
  onChange?: (s: AppSettings, structural: boolean) => void
  onRelayout?: () => void
  onChangeVault?: () => void
  onOpenAgent?: () => void
  private section: Section = 'theme'
  private vault = { name: '', path: '', notes: 0, links: 0 }
  private body!: HTMLElement

  constructor(
    private el: HTMLElement,
    private settings: AppSettings
  ) {
    el.innerHTML = `
      <div class="settings-sheet glass" role="dialog" aria-modal="true" aria-label="Impostazioni">
        <nav class="settings-nav">
          <div class="settings-nav-title">Impostazioni</div>
          ${SECTIONS.map((s) => `<button class="nav-item" data-section="${s.id}">${s.icon}<span>${s.label}</span></button>`).join('')}
          <div class="settings-nav-foot">Second Brain</div>
        </nav>
        <section class="settings-main">
          <button class="icon-btn sm settings-close" data-action="close" title="Chiudi (esc)">${icons.close}</button>
          <div class="settings-body"></div>
        </section>
      </div>`
    this.body = el.querySelector('.settings-body')!

    el.addEventListener('mousedown', (e) => {
      if (e.target === el) this.close()
    })
    el.addEventListener('input', (e) => this.onInput(e.target as HTMLInputElement))
    el.addEventListener('click', (e) => this.onClick(e))
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden')
  }

  open(section?: Section): void {
    if (section) this.section = section
    this.el.classList.remove('hidden')
    this.paint()
  }

  close(): void {
    this.el.classList.add('hidden')
  }

  toggle(section?: Section): void {
    if (this.isOpen && (!section || section === this.section)) this.close()
    else this.open(section)
  }

  /** Settings changed elsewhere (dock, shortcuts): keep the window in sync. */
  update(s: AppSettings): void {
    this.settings = { ...s }
    if (this.isOpen) this.paint()
  }

  setVault(name: string, path: string, notes: number, links: number): void {
    this.vault = { name, path, notes, links }
    if (this.isOpen && this.section === 'vault') this.paint()
  }

  /* ---------------------------------------------------------------- events */

  private onInput(input: HTMLInputElement): void {
    const key = input.dataset.key as keyof AppSettings | undefined
    if (!key) return
    if (input.type === 'range') {
      ;(this.settings[key as NumKey] as number) = Number(input.value)
      const out = this.el.querySelector(`[data-out="${key}"]`)
      if (out) out.textContent = fmt(Number(input.value))
      setFill(input)
      this.emit(false)
    } else if (input.type === 'checkbox') {
      ;(this.settings[key as BoolKey] as boolean) = input.checked
      const all = [...GRAPH_TOGGLES, ...CONTENT_TOGGLES, ...MOTION_TOGGLES, ...Object.values(VIEW_TOGGLES).flat()]
      this.emit(!!all.find((t) => t.key === key)?.structural)
    }
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement
    const nav = t.closest<HTMLElement>('[data-section]')
    if (nav) {
      this.section = nav.dataset.section as Section
      this.paint()
      return
    }
    const view = t.closest<HTMLElement>('[data-view]')?.dataset.view as ViewMode | undefined
    if (view && view !== this.settings.view) {
      this.settings.view = view
      this.emit(false)
      this.paint()
      return
    }
    const tone = t.closest<HTMLElement>('[data-tone]')?.dataset.tone as Tone | undefined
    if (tone) {
      this.settings.tone = tone
      this.emit(false)
      this.paint()
      return
    }
    const accent = t.closest<HTMLElement>('[data-accent]')?.dataset.accent
    if (accent) {
      this.settings.accent = accent
      this.emit(false)
      this.paint()
      return
    }
    const action = t.closest<HTMLElement>('[data-action]')?.dataset.action
    if (action === 'close') this.close()
    else if (action === 'relayout') this.onRelayout?.()
    else if (action === 'vault') this.onChangeVault?.()
    else if (action === 'agent') this.onOpenAgent?.()
    else if (action === 'reset-view') {
      const s = this.settings as unknown as Record<string, unknown>
      for (const k of VIEW_KEYS[this.settings.view]) s[k] = DEFAULT_SETTINGS[k]
      this.emit(false)
      this.paint()
    }
  }

  private emit(structural: boolean): void {
    this.onChange?.({ ...this.settings }, structural)
  }

  /* ---------------------------------------------------------------- render */

  private paint(): void {
    this.el.querySelectorAll<HTMLElement>('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.section === this.section))
    const meta = SECTIONS.find((s) => s.id === this.section)!
    const scroll = this.body.scrollTop
    this.body.innerHTML = `
      <header class="settings-head"><h2>${meta.label}</h2><p>${meta.lead}</p></header>
      ${this.renderSection()}`
    this.body.querySelectorAll<HTMLInputElement>('input[type=range]').forEach(setFill)
    this.body.scrollTop = scroll
  }

  private renderSection(): string {
    const s = this.settings
    switch (this.section) {
      case 'theme': {
        const sliders = VIEW_SLIDERS[s.view]
        const toggles = VIEW_TOGGLES[s.view]
        const viewName = VIEWS.find((v) => v.id === s.view)!.name
        return `
          ${group(
            'Vista',
            `<div class="view-cards">${VIEWS.map(
              (v) => `<button class="view-card ${v.id === s.view ? 'active' : ''}" data-view="${v.id}" aria-pressed="${v.id === s.view}">
                  <span class="view-preview">${preview(v.id, isLight({ ...s, view: 'minimal' }))}</span>
                  <span class="view-meta"><b>${v.name}</b><kbd>${v.key}</kbd></span>
                  <small>${v.tagline}</small>
                  <span class="view-check">${icons.check}</span>
                </button>`
            ).join('')}</div>`,
            true
          )}
          ${group(
            `Aspetto · ${viewName}`,
            card(
              (s.view === 'minimal'
                ? row(
                    'Tono',
                    'Chiaro come la carta o scuro; «Sistema» segue macOS',
                    `<div class="segmented">${TONES.map(
                      (t) => `<button data-tone="${t.id}" class="${s.tone === t.id ? 'on' : ''}">${t.icon}<span>${t.label}</span></button>`
                    ).join('')}</div>`
                  )
                : '') +
                toggles.map((t) => toggleRow(t, s)).join('') +
                sliders.map((d) => sliderRow(d, s)).join('')
            ) + `<button class="link-btn reset" data-action="reset-view">${icons.reset}Ripristina l’aspetto predefinito di ${viewName}</button>`
          )}
          ${group(
            'Colore d’accento',
            card(
              row(
                'Accento',
                'Pulsanti, selezioni e indicatori dell’interfaccia',
                `<div class="swatches">${ACCENTS.map(
                  (a) => `<button class="swatch ${a.color === s.accent ? 'on' : ''}" data-accent="${a.color}" title="${a.name}" style="--c:${a.color}"></button>`
                ).join('')}</div>`
              )
            )
          )}`
      }
      case 'graph':
        return `
          ${group('Neuroni e sinapsi', card(GRAPH_SLIDERS.map((d) => sliderRow(d, s)).join('') + GRAPH_TOGGLES.map((t) => toggleRow(t, s)).join('')))}
          ${group('Contenuto', card(CONTENT_TOGGLES.map((t) => toggleRow(t, s)).join('')))}
          ${group(
            'Layout',
            card(
              row(
                'Ricalcola layout',
                'Ridispone da zero tutti i neuroni secondo le regioni',
                `<button class="btn ghost sm" data-action="relayout">${icons.refresh}Ricalcola</button>`
              )
            )
          )}`
      case 'motion':
        return group('Camera e aiuti', card(MOTION_TOGGLES.map((t) => toggleRow(t, s)).join('')))
      case 'vault': {
        const v = this.vault
        return `
          ${group(
            'Vault aperto',
            card(
              v.name
                ? `<div class="vault-summary">
                    <span class="vi">${icons.vault}</span>
                    <span class="vt"><b>${esc(v.name)}</b><small>${esc(v.path.replace(/^\/Users\/[^/]+/, '~'))}</small></span>
                  </div>
                  <div class="vault-stats"><span><b>${v.notes.toLocaleString('it-IT')}</b> neuroni</span><span><b>${v.links.toLocaleString('it-IT')}</b> sinapsi</span></div>`
                : `<p class="muted pad">Nessun vault aperto.</p>`
            )
          )}
          ${group(
            'Azioni',
            card(
              row('Cambia vault', 'Apri un altro vault di Obsidian o una cartella qualsiasi', `<button class="btn ghost sm" data-action="vault">${icons.folder}Scegli…</button>`) +
                row('Ricalcola layout', 'Utile dopo grandi riorganizzazioni del vault', `<button class="btn ghost sm" data-action="relayout">${icons.refresh}Ricalcola</button>`)
            )
          )}`
      }
      case 'agent':
        return group(
          'Agente locale',
          card(
            `<p class="pad muted">L’agente usa un modello locale (Ollama o LM Studio) per leggere, cercare e modificare le note del vault. Ogni modifica passa da un’anteprima con diff e si può annullare.</p>` +
              row(
                'Modello, ricerca semantica e MCP',
                'Server, modello di chat, embedding e configurazione per altre app',
                `<button class="btn ghost sm" data-action="agent">${icons.agent}Apri</button>`
              )
          )
        )
      case 'keys':
        return SHORTCUTS.map((g) =>
          group(
            g.group,
            card(g.keys.map(([k, label]) => `<div class="set-row key-row"><span>${label}</span><span class="keys">${k.split(' ').filter(Boolean).map((x) => `<kbd>${x}</kbd>`).join('')}</span></div>`).join(''))
          )
        ).join('')
    }
  }
}

/* ------------------------------------------------------------------ helpers */

const group = (title: string, content: string, bare = false): string =>
  `<div class="set-group${bare ? ' bare' : ''}"><h3>${title}</h3>${content}</div>`

const card = (content: string): string => (content ? `<div class="set-card">${content}</div>` : '')

const row = (label: string, hint: string, control: string): string =>
  `<div class="set-row"><div class="set-label"><span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</div><div class="set-control">${control}</div></div>`

function toggleRow(t: ToggleDef, s: AppSettings): string {
  return `<label class="set-row toggle-row"><div class="set-label"><span>${t.label}</span>${t.hint ? `<small>${t.hint}</small>` : ''}</div>
    <span class="toggle"><input type="checkbox" data-key="${t.key}" ${s[t.key] ? 'checked' : ''} /><i></i></span></label>`
}

function sliderRow(d: SliderDef, s: AppSettings): string {
  const v = s[d.key]
  return `<label class="set-row slider-row"><div class="set-label"><span>${d.label}</span>${d.hint ? `<small>${d.hint}</small>` : ''}</div>
    <div class="set-control"><input type="range" data-key="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}" /><output data-out="${d.key}">${fmt(v)}</output></div></label>`
}

const fmt = (v: number): string => v.toFixed(2)

/** Paints the filled part of a range track with the accent colour. */
function setFill(input: HTMLInputElement): void {
  const min = Number(input.min)
  const max = Number(input.max)
  input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`)
}

/** Small illustrations of the three views for the cards. */
function preview(view: ViewMode, light: boolean): string {
  const nodes: [number, number, number][] = [
    [30, 26, 4], [52, 18, 3], [44, 40, 5], [70, 30, 3], [86, 46, 4], [64, 52, 3], [24, 48, 3], [96, 22, 3], [78, 14, 2.5], [40, 58, 2.5]
  ]
  const edges = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [4, 5], [2, 5], [0, 6], [6, 2], [3, 7], [7, 8], [1, 8], [5, 9], [9, 6]]
  const hues = ['#7aa6d6', '#c88aa8', '#9b8fd1', '#6fb5a8', '#d8b36e']
  const col = (i: number): string => hues[i % hues.length]
  const line = (a: number, b: number, extra = ''): string =>
    `<line x1="${nodes[a][0]}" y1="${nodes[a][1]}" x2="${nodes[b][0]}" y2="${nodes[b][1]}" ${extra}/>`
  if (view === 'nebula') {
    return `<svg viewBox="0 0 120 72" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="pv-n1"><stop offset="0" stop-color="#6fb5a8" stop-opacity=".35"/><stop offset="1" stop-color="#6fb5a8" stop-opacity="0"/></radialGradient>
        <radialGradient id="pv-n2"><stop offset="0" stop-color="#9b8fd1" stop-opacity=".4"/><stop offset="1" stop-color="#9b8fd1" stop-opacity="0"/></radialGradient>
        <radialGradient id="pv-ns"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".35" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="120" height="72" fill="#090b11"/>
      <circle cx="40" cy="34" r="30" fill="url(#pv-n1)"/><circle cx="82" cy="36" r="28" fill="url(#pv-n2)"/>
      <g stroke="#b9c2e0" stroke-opacity=".28" stroke-width=".6">${edges.map(([a, b]) => line(a, b)).join('')}</g>
      ${nodes.map((n, i) => `<circle cx="${n[0]}" cy="${n[1]}" r="${n[2] * 1.9}" fill="${col(i)}" opacity=".18"/><circle cx="${n[0]}" cy="${n[1]}" r="${n[2] * 0.75}" fill="${col(i)}"/>`).join('')}
      <circle cx="44" cy="40" r="7" fill="url(#pv-ns)" opacity=".5"/>
    </svg>`
  }
  if (view === 'minimal') {
    const bg = light ? '#f4f4f1' : '#111318'
    const ink = light ? '#2a2e38' : '#9aa0b2'
    return `<svg viewBox="0 0 120 72" preserveAspectRatio="xMidYMid slice">
      <rect width="120" height="72" fill="${bg}"/>
      <g stroke="${ink}" stroke-opacity="${light ? 0.35 : 0.4}" stroke-width=".7">${edges.map(([a, b]) => line(a, b)).join('')}</g>
      ${nodes.map((n, i) => `<circle cx="${n[0]}" cy="${n[1]}" r="${n[2] * 0.8}" fill="${col(i)}"/>`).join('')}
      <circle cx="44" cy="40" r="2" fill="${bg}"/>
    </svg>`
  }
  const grid = Array.from({ length: 9 }, (_, i) => `<line x1="${60 + (i - 4) * 9}" y1="58" x2="${60 + (i - 4) * 26}" y2="72"/>`).join('')
  return `<svg viewBox="0 0 120 72" preserveAspectRatio="xMidYMid slice">
    <defs><linearGradient id="pv-hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1824"/><stop offset="1" stop-color="#03070c"/></linearGradient></defs>
    <rect width="120" height="72" fill="url(#pv-hg)"/>
    <g stroke="#52dbff" stroke-opacity=".28" stroke-width=".5">${grid}<line x1="0" y1="62" x2="120" y2="62"/><line x1="0" y1="67" x2="120" y2="67"/></g>
    <g stroke="#52dbff" stroke-opacity=".55" stroke-width=".6" stroke-dasharray="2 1.5">${edges.map(([a, b]) => line(a, b)).join('')}</g>
    ${nodes.map((n) => `<circle cx="${n[0]}" cy="${n[1]}" r="${n[2] * 0.9}" fill="#52dbff" fill-opacity=".12" stroke="#8eeaff" stroke-width=".7"/><circle cx="${n[0]}" cy="${n[1]}" r=".9" fill="#d9f8ff"/>`).join('')}
    <circle cx="44" cy="40" r="8" fill="none" stroke="#d9f8ff" stroke-width=".6" stroke-dasharray="1.6 1.4"/>
    <g fill="#52dbff" opacity=".06">${Array.from({ length: 18 }, (_, i) => `<rect y="${i * 4}" width="120" height="1.4"/>`).join('')}</g>
  </svg>`
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
