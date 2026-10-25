import { LANGS, getLang, t } from '@shared/i18n'
import type { BuiltinModelInfo, SetupInfo } from '@shared/types'
import { icons } from './icons'

type Step = 'language' | 'agent' | 'demo' | 'ready'
const STEPS: Step[] = ['language', 'agent', 'demo', 'ready']

/** What each catalog model is good for, shown next to its size. */
const BLURB: Record<string, () => string> = {
  'qwen3.5-4b': () => t('Leggero e veloce. Va bene anche con 8–16 GB di memoria.'),
  'qwen3.5-9b': () => t('Più preciso nei ragionamenti lunghi. Meglio con 24 GB di memoria o più.')
}

const gb = (bytes: number): string => (bytes / 1e9).toFixed(1).replace('.', getLang() === 'en' ? '.' : ',')

/**
 * First-run wizard: language, local agent (which model to download), demo vault. It only collects the
 * choices; the models then download in the background while the user already explores the demo vault.
 */
export class SetupWizard {
  /** Called when the wizard ends, with the demo vault to open (null: show the vault picker). */
  onDone?: (demoVault: string | null) => void

  private step: Step = 'language'
  private info: SetupInfo | null = null
  private models: BuiltinModelInfo | null = null
  private agent = true
  private picked = new Set<string>()
  private demo = true
  private folder = ''
  private busy = false
  private error = ''

  constructor(private el: HTMLElement) {
    el.addEventListener('click', (e) => void this.onClick(e))
    el.addEventListener('change', (e) => this.onChange(e))
  }

  async show(info: SetupInfo): Promise<void> {
    this.info = info
    this.folder = info.defaultFolder
    this.models = await window.api.builtinModels()
    this.picked = new Set([this.models.recommended])
    this.step = 'language'
    this.paint()
    this.el.classList.remove('hidden')
  }

  private paint(): void {
    const i = STEPS.indexOf(this.step)
    const dots = STEPS.map((_, n) => `<i class="${n === i ? 'on' : n < i ? 'past' : ''}"></i>`).join('')
    const body = { language: () => this.languageStep(), agent: () => this.agentStep(), demo: () => this.demoStep(), ready: () => this.readyStep() }[this.step]()
    const back = i > 0 && !this.busy ? `<button class="btn ghost" data-action="back">${t('Indietro')}</button>` : '<span></span>'
    const last = this.step === 'ready'
    const canNext = this.step !== 'agent' || !this.agent || this.picked.size > 0
    this.el.innerHTML = `
      <div class="welcome-card setup-card glass">
        <div class="setup-dots">${dots}</div>
        ${body}
        ${this.error ? `<p class="error">${esc(this.error)}</p>` : ''}
        <div class="setup-nav">
          ${back}
          <button class="btn primary" data-action="${last ? 'start' : 'next'}" ${canNext && !this.busy ? '' : 'disabled'}>${
            last ? (this.busy ? t('Preparo tutto…') : t('Inizia')) : t('Continua')
          }</button>
        </div>
      </div>`
  }

  private languageStep(): string {
    return `<div class="orb"></div>
      <h1>Second Brain</h1>
      <p class="lead">${t('Esplora le tue note come una rete neurale in 3D e parlaci con un agente che gira sul tuo computer.')}</p>
      <h4>${t('Lingua')}</h4>
      <div class="setup-langs">${LANGS.map((l) => `<button class="setup-choice ${l.id === getLang() ? 'on' : ''}" data-lang="${l.id}"><b>${l.label}</b></button>`).join('')}</div>
      <p class="muted setup-note">${t('Ti guido in tre passi: ci vuole un minuto. Le tue note restano sempre sul tuo computer.')}</p>`
  }

  private agentStep(): string {
    const models = this.models?.models ?? []
    const rec = this.models?.recommended
    const total = models.filter((m) => this.picked.has(m.id)).reduce((a, m) => a + (m.installed ? 0 : m.size - m.partial), 0)
    return `<h2>${t("L'agente locale")}</h2>
      <p class="lead">${t("L'agente è un modello di intelligenza artificiale che legge e scrive le tue note. Gira sul tuo computer, quindi funziona senza internet e niente esce dal Mac o dal PC.")}</p>
      <label class="toggle setup-toggle"><span>${t("Scarica l'agente locale")}</span><input type="checkbox" data-agent ${this.agent ? 'checked' : ''}><i></i></label>
      ${
        this.agent
          ? `<div class="setup-models">${models
              .map(
                (m) => `<label class="setup-choice model ${this.picked.has(m.id) ? 'on' : ''}">
                  <input type="checkbox" data-model="${m.id}" ${this.picked.has(m.id) ? 'checked' : ''}>
                  <span class="mt"><b>${esc(m.label)}</b>${m.id === rec ? `<em>${t('consigliato per questo computer')}</em>` : ''}
                    <small>${BLURB[m.id]?.() ?? ''}</small></span>
                  <span class="ms">${m.installed ? t('già scaricato') : `${gb(m.size)} GB`}</span>
                </label>`
              )
              .join('')}</div>
            <p class="muted setup-note">${
              this.picked.size === 0
                ? t('Scegli almeno un modello, oppure disattiva il download.')
                : total
                  ? t('Da scaricare: {size} GB, una volta sola, da Hugging Face. Il download continua in background mentre usi l’app.', { size: gb(total) })
                  : t('Già tutto sul computer.')
            }${this.picked.size === 2 ? ' ' + t('Con entrambi potrai passare dall’uno all’altro dalle impostazioni.') : ''}</p>`
          : `<p class="muted setup-note">${t("Va bene anche così: potrai scaricarlo più avanti dall'agente, oppure usare Ollama o LM Studio se li hai già.")}</p>`
      }`
  }

  private demoStep(): string {
    return `<h2>${t('Un vault di prova')}</h2>
      <p class="lead">${t('Un piccolo vault già pronto, con una ventina di note collegate su cervello, intelligenza artificiale e metodi di studio. Serve per provare l’app senza preparare nulla.')}</p>
      <label class="toggle setup-toggle"><span>${t('Crea il vault di prova')}</span><input type="checkbox" data-demo ${this.demo ? 'checked' : ''}><i></i></label>
      ${
        this.demo
          ? `<div class="setup-folder"><span class="ficon">${icons.folder}</span><span class="fpath" title="${esc(this.folder)}">${esc(shortPath(this.folder))}</span>
              <button class="link-btn" data-action="folder">${t('Cambia…')}</button></div>
            <p class="muted setup-note">${t('Verrà creata una cartella «{name}» qui dentro. Puoi eliminarla quando vuoi.', { name: t('Second Brain - Demo') })}</p>`
          : `<p class="muted setup-note">${t('Al prossimo passo sceglierai il vault Obsidian o la cartella di note da aprire.')}</p>`
      }`
  }

  private readyStep(): string {
    const rows: string[] = []
    const names = (this.models?.models ?? []).filter((m) => this.picked.has(m.id)).map((m) => m.label)
    rows.push(
      this.agent && names.length
        ? `<li>${icons.download}<span>${t('Agente locale: {names}', { names: esc(names.join(' + ')) })}</span></li>`
        : `<li class="off">${icons.download}<span>${t('Agente locale: più avanti')}</span></li>`
    )
    rows.push(
      this.demo
        ? `<li>${icons.vault}<span>${t('Vault di prova in {path}', { path: esc(shortPath(this.folder)) })}</span></li>`
        : `<li class="off">${icons.vault}<span>${t('Nessun vault di prova')}</span></li>`
    )
    return `<h2>${t('Tutto pronto')}</h2>
      <ul class="setup-sum">${rows.join('')}</ul>
      <p class="muted setup-note">${
        this.agent && names.length
          ? t("Quando premi Inizia l'app si apre e il download dell'agente parte in background: vedrai l'avanzamento in basso. Nel frattempo puoi già esplorare le note.")
          : t("Quando premi Inizia l'app si apre.")
      }</p>`
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLInputElement
    if (el.matches('[data-agent]')) this.agent = el.checked
    else if (el.matches('[data-demo]')) this.demo = el.checked
    else if (el.dataset.model) {
      if (el.checked) this.picked.add(el.dataset.model)
      else this.picked.delete(el.dataset.model)
    } else return
    this.paint()
  }

  private async onClick(e: MouseEvent): Promise<void> {
    const target = e.target as HTMLElement
    const lang = target.closest<HTMLElement>('[data-lang]')?.dataset.lang
    if (lang) {
      if (lang !== getLang()) {
        await window.api.setLanguage(lang as 'it' | 'en')
        location.reload()
      }
      return
    }
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
    if (!action || this.busy) return
    this.error = ''
    const i = STEPS.indexOf(this.step)
    if (action === 'next') this.step = STEPS[i + 1]
    else if (action === 'back') this.step = STEPS[i - 1]
    else if (action === 'folder') {
      const dir = await window.api.chooseFolder(t('Dove creare il vault di prova'))
      if (dir) this.folder = dir
    } else if (action === 'start') return this.finish()
    this.paint()
  }

  private async finish(): Promise<void> {
    this.busy = true
    this.paint()
    try {
      const demo = this.demo ? await window.api.installDemo(this.folder) : null
      const ids = [...this.picked]
      if (this.agent && ids.length) {
        // the recommended model among those picked is the one in use; the others are extra downloads
        const first = ids.includes(this.models!.recommended) ? this.models!.recommended : ids[0]
        const queue = [first, ...ids.filter((id) => id !== first)]
        await window.api.aiSaveSettings({ ...(await window.api.aiGetSettings()), provider: 'builtin', model: first, embedModel: '' })
        void window.api.builtinDownload(queue)
      }
      await window.api.setupFinish()
      this.el.classList.add('hidden')
      this.busy = false
      this.onDone?.(demo)
    } catch (err) {
      this.busy = false
      this.error = t('Qualcosa è andato storto: {error}', { error: err instanceof Error ? err.message : String(err) })
      this.paint()
    }
  }
}

/** A pill at the bottom while a model downloads: progress, pause, and a click to open the agent. */
export class DownloadBadge {
  onOpen?: () => void
  private labels = new Map<string, string>()
  /** The model whose download is paused: a click on the pill resumes it. */
  private paused: string | null = null

  constructor(private el: HTMLElement) {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-pause]')) void window.api.builtinCancel()
      else if (this.paused) void window.api.builtinDownload(this.paused)
      else this.onOpen?.()
    })
    void window.api.builtinModels().then((info) => info.models.forEach((m) => this.labels.set(m.id, m.label)))
    window.api.onBuiltinProgress((p) => {
      const name = this.labels.get(p.id) ?? p.id
      this.paused = p.phase === 'paused' ? p.id : null
      if (p.phase === 'downloading' || p.phase === 'verifying') {
        const pct = p.total ? Math.min(100, (p.received / p.total) * 100) : 0
        const text = p.phase === 'verifying' ? t('Verifico {name}…', { name }) : t('Scarico {name} · {pct}%', { name, pct: Math.floor(pct) })
        this.el.innerHTML = `<span>${esc(text)}</span><div class="dl-bar"><i style="width:${pct.toFixed(1)}%"></i></div>${
          p.phase === 'downloading' ? `<button class="link-btn" data-pause>${t('Pausa')}</button>` : ''
        }`
        this.el.classList.remove('hidden', 'err')
      } else if (p.phase === 'done') {
        this.el.innerHTML = `<span>${icons.check}${esc(t('{name} è pronto', { name }))}</span>`
        this.el.classList.remove('hidden', 'err')
        // a queued model starts right after; with nothing else coming the pill fades away
        window.setTimeout(() => {
          if (this.el.textContent?.includes(name)) this.el.classList.add('hidden')
        }, 4000)
      } else {
        this.el.innerHTML = `<span>${esc(p.phase === 'paused' ? t('Download in pausa') : t('Download non riuscito'))}</span><button class="link-btn">${
          p.phase === 'paused' ? t('Riprendi') : t('Dettagli')
        }</button>`
        this.el.classList.remove('hidden')
        this.el.classList.toggle('err', p.phase === 'error')
      }
    })
  }
}

const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
