import {
  DEFAULT_AI,
  type AgentEvent,
  type AgentPhase,
  type AgentToolCall,
  type AiSettings,
  type AiStatus,
  type BuiltinModelInfo,
  type DiffLine,
  type IndexStatus,
  type ModelDownloadProgress
} from '@shared/types'
import { getLang, t } from '@shared/i18n'
import { icons } from './icons'
import { decorateCallouts, renderMarkdown } from './markdown'

export interface AgentPanelHost {
  /** Resolves a [[target]] written by the model to a node id. */
  resolve(target: string): string | null
  exists(id: string): boolean
  openNote(id: string): void
  focusNodes(ids: string[]): void
  onActivity(ids: string[], follow: boolean): void
  onClear(): void
  onToggle(open: boolean): void
}

type Segment =
  | { kind: 'text'; text: string; el: HTMLElement }
  | { kind: 'reasoning'; text: string; el: HTMLElement }
  | { kind: 'tool'; el: HTMLElement }
  | { kind: 'other'; el: HTMLElement }

// generic enough for any vault; the last one fits the demo vault
const SUGGESTIONS = [
  'Di cosa parla il mio vault? Riassumilo regione per regione',
  'Quali collegamenti mancano tra le mie note?',
  'Quali sono le note più collegate e perché?',
  'Come sono collegati il cervello e le reti neurali?'
]

/** Frames of the status glyph, cycled while the agent works (as in Claude Code). */
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
/** After this long without a single token, the model is most likely still being loaded into memory. */
const SLOW_START_MS = 12000

const PROVIDERS: { id: AiSettings['provider']; label: string; url: string }[] = [
  { id: 'builtin', label: 'Integrato (nessuna installazione)', url: '' },
  { id: 'ollama', label: 'Ollama', url: 'http://localhost:11434' },
  { id: 'openai', label: 'LM Studio / server compatibile OpenAI', url: 'http://localhost:1234/v1' }
]

/** Chat with the local AI agent, plus its settings. */
export class AgentPanel {
  private settings: AiSettings = { ...DEFAULT_AI }
  private status: AiStatus | null = null
  private builtin: BuiltinModelInfo | null = null
  private download: ModelDownloadProgress | null = null
  private index: IndexStatus | null = null
  private running = false
  private eco = false
  private segments: Segment[] = []
  private message: HTMLElement | null = null
  private tools = new Map<string, { call: AgentToolCall; el: HTMLElement }>()
  private renderQueued = new Set<Segment>()
  private live: {
    el: HTMLElement
    timer: number
    started: number
    phase: AgentPhase
    text: string
    tokens: number
    frame: number
    /** Index of the first segment produced in the current phase. */
    since: number
  } | null = null
  private saveTimer: number | undefined
  private messagesEl: HTMLElement
  private input: HTMLTextAreaElement
  private sendBtn: HTMLButtonElement
  private settingsEl: HTMLElement
  private chatEl: HTMLElement

  constructor(
    private root: HTMLElement,
    private host: AgentPanelHost
  ) {
    root.innerHTML = `
      <div class="agent-head">
        <span class="agent-title">${t('Agente')}</span>
        <button class="model-chip" data-action="settings" title="${t('Impostazioni del modello')}"><i></i><span>—</span></button>
        <div class="agent-actions">
          <button class="icon-btn sm" data-action="new" title="${t('Nuova conversazione')}">${icons.plus}</button>
          <button class="icon-btn sm" data-action="settings" title="${t('Impostazioni AI')}">${icons.sliders}</button>
          <button class="icon-btn sm" data-action="close" title="${t('Chiudi')} (${document.documentElement.dataset.platform === 'mac' ? '⌘' : 'Ctrl '}J)">${icons.close}</button>
        </div>
      </div>
      <div class="agent-eco hidden">${icons.leaf}<span><b>${t('Modalità Eco')}</b> · ${t('l’agente cerca e legge le note, ma non crea né modifica nulla e non guarda le immagini. Passa a Basic per l’agente completo.')}</span></div>
      <div class="agent-chat">
        <div class="agent-messages"></div>
        <form class="agent-composer">
          <textarea rows="1" placeholder="${t('Chiedi qualcosa al tuo second brain…')}" spellcheck="false"></textarea>
          <button type="submit" class="send" title="${t('Invia')} (↵)">${icons.send}</button>
        </form>
      </div>
      <div class="agent-settings hidden"></div>`
    this.messagesEl = root.querySelector('.agent-messages')!
    this.input = root.querySelector('textarea')!
    this.sendBtn = root.querySelector('.send')!
    this.settingsEl = root.querySelector('.agent-settings')!
    this.chatEl = root.querySelector('.agent-chat')!

    root.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault()
      if (this.running) void window.api.agentStop()
      else this.submit()
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        if (!this.running) this.submit()
      }
    })
    this.input.addEventListener('input', () => this.autosize())
    root.addEventListener('click', (e) => this.onClick(e))
    window.api.onAgentEvent((ev) => this.handle(ev))
    window.api.onBuiltinProgress((p) => this.onDownload(p))
    window.api.onIndexStatus((s) => {
      this.index = s
      this.paintIndex()
    })
    void this.init()
  }

  private async init(): Promise<void> {
    this.settings = await window.api.aiGetSettings()
    await this.refreshStatus()
    this.paintEmpty()
  }

  /** Picks up settings saved elsewhere (the first-run wizard chooses the built-in model). */
  async reloadSettings(): Promise<void> {
    this.settings = await window.api.aiGetSettings()
    await this.refreshStatus()
    this.paintEmpty()
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('hidden')
  }

  toggle(force?: boolean): void {
    const open = force ?? !this.isOpen
    this.root.classList.toggle('hidden', !open)
    this.host.onToggle(open)
    if (open) {
      void this.refreshStatus()
      requestAnimationFrame(() => this.input.focus())
    }
  }

  /** Opens the panel straight on the model settings. */
  /** Eco mode: the main process only offers read tools and no images; the panel says so. */
  setEco(on: boolean): void {
    this.eco = on
    this.root.querySelector('.agent-eco')!.classList.toggle('hidden', !on)
    this.root.classList.toggle('eco', on)
  }

  openSettings(): void {
    this.toggle(true)
    this.showSettings(true)
  }

  /* ---------------------------------------------------------------- status */

  private async refreshStatus(): Promise<void> {
    ;[this.status, this.builtin] = await Promise.all([window.api.aiStatus(this.settings), window.api.builtinModels()])
    // first run with Ollama: pick a model automatically
    if (this.status.ok && !this.settings.model && this.status.models.length) {
      this.settings.model = this.status.models.find((m) => !/embed/i.test(m)) ?? this.status.models[0]
      await window.api.aiSaveSettings(this.settings)
    }
    this.paintChip()
    if (!this.settingsEl.classList.contains('hidden')) this.paintSettings()
    if (!this.messagesEl.querySelector('.msg')) this.paintEmpty()
  }

  private paintChip(): void {
    const chip = this.root.querySelector('.model-chip')!
    const ok = this.status?.ok && this.settings.model && this.status.models.includes(this.settings.model)
    chip.className = 'model-chip ' + (ok ? 'ok' : this.status?.ok ? 'warn' : 'off')
    chip.querySelector('span')!.textContent = this.status?.ok ? this.modelLabel(this.settings.model) || t('scegli un modello') : t('non collegato')
  }

  private paintEmpty(): void {
    if (this.messagesEl.querySelector('.msg')) return
    const ready = this.status?.ok && this.settings.model
    this.messagesEl.innerHTML = ready
      ? `<div class="agent-empty">
          <p>${t("Fai una domanda sul tuo vault. L'agente cerca e legge le note, ragiona sui collegamenti e — se glielo chiedi — crea o modifica neuroni, chiedendoti conferma per ogni modifica.")}</p>
          <div class="suggestions">${SUGGESTIONS.map((s) => `<button class="suggestion">${esc(t(s))}</button>`).join('')}</div>
        </div>`
      : this.setupHtml()
  }

  /** First run: no model reachable. Offer the built-in model, keep Ollama / LM Studio as the advanced path. */
  private setupHtml(): string {
    const info = this.builtin
    const rec = info?.models.find((m) => m.id === info.recommended)
    const why = rec
      ? t('{name}, scelto in base alla memoria di questo computer ({ram} GB). Si scarica una volta sola e poi funziona senza internet: le note non escono dal computer.', { name: esc(rec.label), ram: info!.ramGb })
      : ''
    return `<div class="agent-empty">
        <h4>${t("Attiva l'agente")}</h4>
        <p>${t("L'agente usa un modello di intelligenza artificiale che gira sul tuo computer.")} ${why}</p>
        <div class="dl-slot">${this.setupAction()}</div>
        <details class="adv">
          <summary>${t('Hai già Ollama o LM Studio?')}</summary>
          ${this.settings.provider !== 'builtin' && this.status?.error ? `<p class="muted">${esc(this.status.error)}</p>` : ''}
          <ol>
            <li>${t('Avvia <b>Ollama</b> (oppure il server di LM Studio).')}</li>
            <li>${t('Assicurati di avere un modello che supporta gli strumenti (es. Qwen 3, Llama 3.1, Mistral).')}</li>
            <li>${t("Sceglilo nelle impostazioni dell'agente.")}</li>
          </ol>
          <div class="row"><button class="btn" data-action="retry">${icons.refresh}${t('Riprova')}</button><button class="btn ghost" data-action="settings">${icons.sliders}${t('Impostazioni')}</button></div>
        </details>
      </div>`
  }

  /** The download button, or its progress bar while it runs. */
  private setupAction(): string {
    const info = this.builtin
    const rec = info?.models.find((m) => m.id === info.recommended)
    const installed = info?.models.find((m) => m.installed)
    const d = this.download
    const note =
      d?.phase === 'error'
        ? `<p class="error">${esc(d.error ?? t('Download non riuscito'))}</p>`
        : d?.phase === 'paused'
          ? `<p class="muted dl-note">${esc(d.error ?? t('Download in pausa.'))}</p>`
          : ''
    if (d && (d.phase === 'downloading' || d.phase === 'verifying')) {
      const pct = d.total ? (d.received / d.total) * 100 : 0
      const eta = d.speed && d.phase === 'downloading' ? ` · ${duration((d.total - d.received) / d.speed)}` : ''
      const meta =
        d.phase === 'verifying'
          ? t('Verifico il file…')
          : `${t('{done} di {total} GB', { done: gb(d.received), total: gb(d.total) })}${d.speed ? ` · ${(d.speed / 1e6).toFixed(1)} MB/s` : ''}${eta}`
      return `<div class="dl">
          <div class="dl-bar"><i style="width:${pct.toFixed(1)}%"></i></div>
          <div class="dl-meta"><span>${meta}</span>${d.phase === 'downloading' ? `<button class="link-btn" data-dl-cancel>${t('Pausa')}</button>` : ''}</div>
        </div>`
    }
    if (installed && this.settings.provider !== 'builtin')
      return `<button class="btn primary" data-use-builtin="${installed.id}">${icons.check}${t('Usa il modello integrato ({name})', { name: esc(installed.label) })}</button>${note}`
    if (!rec) return note
    const partial = rec.partial || (d?.id === rec.id ? d.received : 0)
    return `<button class="btn primary" data-dl="${rec.id}">${icons.download}${
      partial ? t('Riprendi il download ({done} di {total} GB)', { done: gb(partial), total: gb(rec.size) }) : t('Scarica il modello consigliato ({size} GB)', { size: gb(rec.size) })
    }</button>${note}`
  }

  private onDownload(p: ModelDownloadProgress): void {
    this.download = p
    if (p.phase === 'done') {
      this.download = null
      if (p.keep) void window.api.builtinModels().then((b) => ((this.builtin = b), this.paintBuiltinList()))
      else void this.useBuiltin(p.id)
      return
    }
    // repaint only the download slot, so the rest of the card keeps its state
    const slot = this.messagesEl.querySelector('.dl-slot')
    if (slot) slot.innerHTML = this.setupAction()
    if (!this.settingsEl.classList.contains('hidden')) this.paintBuiltinList()
  }

  private async useBuiltin(id: string): Promise<void> {
    this.settings = { ...this.settings, provider: 'builtin', model: id, embedModel: '' }
    await window.api.aiSaveSettings(this.settings)
    await this.refreshStatus()
    if (!this.settingsEl.classList.contains('hidden')) this.paintSettings()
  }

  private async startDownload(id: string): Promise<void> {
    const m = this.builtin?.models.find((x) => x.id === id)
    this.onDownload({ id, received: m?.partial ?? 0, total: m?.size ?? 0, phase: 'downloading' })
    const res = await window.api.builtinDownload(id)
    if (!res.ok) {
      this.builtin = await window.api.builtinModels()
      const slot = this.messagesEl.querySelector('.dl-slot')
      if (slot) slot.innerHTML = this.setupAction()
      this.paintBuiltinList()
    }
  }

  /* ------------------------------------------------------------------ chat */

  private submit(text = this.input.value.trim()): void {
    if (!text || this.running) return
    this.messagesEl.querySelector('.agent-empty')?.remove()
    const user = document.createElement('div')
    user.className = 'msg user'
    user.innerHTML = `<div class="bubble"></div>`
    user.querySelector('.bubble')!.textContent = text
    this.messagesEl.appendChild(user)
    this.message = document.createElement('div')
    this.message.className = 'msg assistant'
    this.messagesEl.appendChild(this.message)
    this.segments = []
    this.startLive()
    this.input.value = ''
    this.autosize()
    this.setRunning(true)
    this.scroll(true)
    void window.api.agentSend(text)
  }

  private setRunning(v: boolean): void {
    this.running = v
    this.sendBtn.innerHTML = v ? icons.stop : icons.send
    this.sendBtn.title = v ? t('Interrompi') : `${t('Invia')} (↵)`
    this.sendBtn.classList.toggle('stop', v)
  }

  handle(e: AgentEvent): void {
    if (!this.message && e.type !== 'activity') return
    switch (e.type) {
      case 'start':
        break
      case 'status':
        this.setLive(e.phase, e.text)
        break
      case 'text':
      case 'reasoning': {
        if (this.live) this.live.tokens++
        let seg = this.segments[this.segments.length - 1]
        if (!seg || seg.kind !== e.type) {
          const el = document.createElement(e.type === 'text' ? 'div' : 'details')
          if (e.type === 'text') el.className = 'markdown answer'
          else {
            el.className = 'reasoning'
            el.innerHTML = `<summary>${t('Ragionamento')}</summary><div class="r-text"></div>`
          }
          this.append(el)
          seg = { kind: e.type, text: '', el } as Segment
          this.segments.push(seg)
        }
        ;(seg as { text: string }).text += e.delta
        this.queueRender(seg)
        break
      }
      case 'tool':
        this.upsertTool(e.call)
        break
      case 'activity':
        this.host.onActivity(e.ids, this.settings.followAgent)
        break
      case 'notice':
        this.appendOther('notice', e.message)
        break
      case 'error':
        this.appendOther('error', e.message)
        this.finish()
        // the built-in model may have just been found damaged and removed
        if (this.settings.provider === 'builtin') void this.refreshStatus()
        break
      case 'done':
        this.finish()
        break
    }
    this.scroll()
  }

  private finish(): void {
    this.stopLive()
    if (this.message && !this.message.childElementCount) this.appendOther('notice', t('Nessuna risposta.'))
    for (const seg of this.renderQueued) this.renderSegment(seg)
    this.renderQueued.clear()
    this.setRunning(false)
    // light up every neuron cited in the answer
    const cited = new Set<string>()
    for (const seg of this.segments) {
      if (seg.kind !== 'text') continue
      for (const m of seg.text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
        const id = this.host.resolve(m[1].split('|')[0].split('#')[0].trim())
        if (id && this.host.exists(id)) cited.add(id)
      }
    }
    if (cited.size) this.host.onActivity([...cited], this.settings.followAgent)
  }

  private appendOther(kind: 'notice' | 'error', text: string): void {
    const el = document.createElement('div')
    el.className = kind
    el.textContent = text
    this.append(el)
    this.segments.push({ kind: 'other', el })
  }

  /** Adds a block to the current answer, keeping the live status line at the bottom. */
  private append(el: HTMLElement): void {
    const msg = this.message
    if (!msg) return
    msg.insertBefore(el, this.live?.el.parentElement === msg ? this.live.el : null)
  }

  /* ----------------------------------------------------------- live status */

  private startLive(): void {
    this.stopLive()
    const el = document.createElement('div')
    el.className = 'agent-status'
    el.innerHTML = `<div class="st-row"><span class="st-glyph"></span><span class="st-text"></span><span class="st-meta"></span></div><div class="st-detail"></div>`
    this.message!.appendChild(el)
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    this.live = { el, timer: 0, started: performance.now(), phase: 'thinking', text: t('Elaboro la richiesta'), tokens: 0, frame: 0, since: 0 }
    this.live.timer = window.setInterval(() => {
      if (this.live && !still) this.live.frame++
      this.paintLive()
    }, 120)
    this.paintLive()
  }

  private setLive(phase: AgentPhase, text: string): void {
    if (!this.live) return
    this.live.phase = phase
    this.live.text = text
    this.live.since = this.segments.length
    this.paintLive()
  }

  private stopLive(): void {
    if (!this.live) return
    clearInterval(this.live.timer)
    this.live.el.remove()
    this.live = null
  }

  private paintLive(): void {
    const l = this.live
    if (!l) return
    const secs = Math.floor((performance.now() - l.started) / 1000)
    const time = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
    const meta = l.tokens ? `${time} · ${l.tokens >= 1000 ? (l.tokens / 1000).toFixed(1) + 'k' : l.tokens} token` : time
    let detail = ''
    if (l.phase === 'reasoning') {
      // the last thing the model is thinking about, one line
      const seg = this.segments.slice(l.since).find((x) => x.kind === 'reasoning') as { text: string } | undefined
      detail = lastSentence(seg?.text ?? '')
    } else if (l.phase === 'thinking' && !l.tokens && performance.now() - l.started > SLOW_START_MS) {
      detail = t('Il primo messaggio può essere lento: il modello si sta caricando in memoria.')
    }
    l.el.dataset.phase = l.phase
    l.el.querySelector('.st-glyph')!.textContent = l.phase === 'awaiting' ? '✋' : GLYPHS[l.frame % GLYPHS.length]
    setText(l.el.querySelector('.st-text')!, `${l.text}…`)
    setText(l.el.querySelector('.st-meta')!, meta)
    setText(l.el.querySelector('.st-detail')!, detail)
  }

  private queueRender(seg: Segment): void {
    if (this.renderQueued.has(seg)) return
    this.renderQueued.add(seg)
    requestAnimationFrame(() => {
      if (!this.renderQueued.delete(seg)) return
      this.renderSegment(seg)
      this.scroll()
    })
  }

  private renderSegment(seg: Segment): void {
    if (seg.kind === 'reasoning') seg.el.querySelector('.r-text')!.textContent = seg.text.trim()
    if (seg.kind !== 'text') return
    const links: Record<string, string> = {}
    for (const m of seg.text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
      const key = m[1].split('|')[0].split('#')[0].split('^')[0].trim()
      links[key] = this.host.resolve(key) ?? 'unresolved:' + key.toLowerCase()
    }
    seg.el.innerHTML = renderMarkdown(seg.text, links, (id) => this.host.exists(id))
    decorateCallouts(seg.el)
  }

  private upsertTool(call: AgentToolCall): void {
    let entry = this.tools.get(call.id)
    if (!entry) {
      const el = document.createElement('div')
      this.append(el)
      this.segments.push({ kind: 'tool', el })
      entry = { call, el }
      this.tools.set(call.id, entry)
    }
    entry.call = call
    const el = entry.el
    el.className = `tool ${call.status}${call.ids?.length ? ' has-ids' : ''}`
    el.dataset.call = call.id
    const ic =
      call.status === 'running'
        ? '<span class="spinner"></span>'
        : call.status === 'done'
          ? icons.check
          : call.status === 'awaiting'
            ? icons.pen
            : icons.close
    let html = `<div class="tool-row" data-focus="${call.id}"><span class="tool-ic">${ic}</span><span class="tool-label">${esc(call.label)}</span>${
      call.summary ? `<span class="tool-sum">${esc(call.summary)}</span>` : ''
    }</div>`
    if (call.preview) {
      const p = call.preview
      html += `<div class="tool-preview">
        <div class="tool-path"><span>${esc(p.path)}</span><em>${p.isNew ? t('nuova nota') : t('modifica')}</em></div>
        <pre class="diff">${diffHtml(p.diff)}</pre>
        ${
          call.status === 'awaiting'
            ? `<div class="tool-approve"><button class="btn primary sm" data-approve="${call.id}">${icons.check}${t('Approva')}</button><button class="btn sm" data-reject="${call.id}">${t('Rifiuta')}</button></div>`
            : call.change && !call.change.undone
              ? `<div class="tool-approve"><button class="btn ghost sm" data-undo="${call.change.changeId}" data-undo-call="${call.id}">${t('Annulla modifica')}</button></div>`
              : call.change?.undone
                ? `<div class="tool-approve muted">${t('Modifica annullata')}</div>`
                : ''
        }
      </div>`
    }
    el.innerHTML = html
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
    if (action === 'close') return this.toggle(false)
    if (action === 'settings') return this.showSettings(this.settingsEl.classList.contains('hidden'))
    if (action === 'retry') return void this.refreshStatus()
    const dl = target.closest<HTMLElement>('[data-dl]')?.dataset.dl
    if (dl) return void this.startDownload(dl)
    if (target.closest('[data-dl-cancel]')) return void window.api.builtinCancel()
    const use = target.closest<HTMLElement>('[data-use-builtin]')?.dataset.useBuiltin
    if (use) return void this.useBuiltin(use)
    if (action === 'new') {
      void window.api.agentReset()
      this.stopLive()
      this.tools.clear()
      this.message = null
      this.messagesEl.innerHTML = ''
      this.setRunning(false)
      this.host.onClear()
      this.showSettings(false)
      this.paintEmpty()
      return
    }
    const sug = target.closest<HTMLElement>('.suggestion')
    if (sug) return this.submit(sug.textContent ?? '')
    const node = target.closest<HTMLElement>('[data-node]')
    if (node) {
      e.preventDefault()
      return this.host.openNote(node.dataset.node!)
    }
    const file = target.closest<HTMLElement>('[data-file]')
    if (file) {
      e.preventDefault()
      return void window.api.openFile(file.dataset.file!)
    }
    const approve = target.closest<HTMLElement>('[data-approve]')?.dataset.approve
    if (approve) return void window.api.agentApprove(approve, true)
    const reject = target.closest<HTMLElement>('[data-reject]')?.dataset.reject
    if (reject) return void window.api.agentApprove(reject, false)
    const undoBtn = target.closest<HTMLElement>('[data-undo]')
    if (undoBtn) return void this.undo(undoBtn.dataset.undo!, undoBtn.dataset.undoCall!)
    const focus = target.closest<HTMLElement>('[data-focus]')?.dataset.focus
    if (focus) {
      const ids = this.tools.get(focus)?.call.ids
      if (ids?.length) this.host.focusNodes(ids)
    }
    if (target.closest('[data-copy]')) void this.copyMcp()
    if (target.closest('[data-index]')) void window.api.indexBuild()
  }

  private async undo(changeId: string, callId: string): Promise<void> {
    const res = await window.api.agentUndo(changeId)
    const entry = this.tools.get(callId)
    if (res.ok && entry?.call.change) {
      entry.call.change.undone = true
      this.upsertTool(entry.call)
    }
    if (!res.ok) {
      const note = document.createElement('div')
      note.className = 'error'
      note.textContent = res.message
      entry?.el.appendChild(note)
      setTimeout(() => note.remove(), 6000)
    }
  }

  /* -------------------------------------------------------------- settings */

  private showSettings(show: boolean): void {
    this.settingsEl.classList.toggle('hidden', !show)
    this.chatEl.classList.toggle('hidden', show)
    if (show) {
      this.paintSettings()
      void window.api.indexStatus().then((s) => {
        this.index = s
        this.paintIndex()
      })
      void this.paintMcp()
    }
  }

  private paintSettings(): void {
    const s = this.settings
    const models = this.status?.models ?? []
    const chatModels = models.filter((m) => !/embed/i.test(m))
    const embedModels = models.filter((m) => /embed|bge|e5|minilm|gte/i.test(m))
    const option = (v: string, label: string, sel: string): string => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`
    this.settingsEl.innerHTML = `
      <div class="set-scroll">
        <h4>${t('Modello')}</h4>
        <label class="field"><span>${t('Server')}</span>
          <select data-k="provider">${PROVIDERS.map((p) => option(p.id, t(p.label), s.provider)).join('')}</select></label>
        ${s.provider === 'builtin' ? '' : `<label class="field"><span>${t('Indirizzo')}</span><input data-k="baseUrl" value="${esc(s.baseUrl)}" spellcheck="false" /></label>`}
        <div class="status-line ${this.status?.ok ? 'ok' : 'off'}">${
          this.status?.ok
            ? s.provider === 'builtin'
              ? models.length === 1 ? t('Pronto · 1 modello scaricato') : t('Pronto · {n} modelli scaricati', { n: models.length })
              : t('Collegato · {n} modelli disponibili', { n: models.length })
            : esc(this.status?.error ?? t('Non collegato'))
        }<button class="link-btn" data-action="retry">${t('Aggiorna')}</button></div>
        ${s.provider === 'builtin' ? '<div class="builtin-list"></div>' : ''}
        <label class="field"><span>${t('Modello di chat')}</span>
          <select data-k="model">${s.model && !chatModels.includes(s.model) ? option(s.model, s.model + ` (${t('non trovato')})`, s.model) : ''}${
            chatModels.length ? chatModels.map((m) => option(m, this.modelLabel(m), s.model)).join('') : option('', '—', s.model)
          }</select></label>
        <label class="field"><span>${t('Contesto (token)')}</span><input data-k="numCtx" type="number" min="2048" step="1024" value="${s.numCtx}" /></label>
        <label class="slider"><span>${t('Temperatura')}<output>${s.temperature.toFixed(2)}</output></span>
          <input data-k="temperature" type="range" min="0" max="1.2" step="0.05" value="${s.temperature}" /></label>
        <label class="toggle"><span>${t('Ragionamento esteso (più lento)')}</span><input type="checkbox" data-k="think" ${s.think ? 'checked' : ''} /><i></i></label>
        <label class="toggle"><span>${t("Segui l'agente nella vista 3D")}</span><input type="checkbox" data-k="followAgent" ${s.followAgent ? 'checked' : ''} /><i></i></label>
        <label class="toggle"><span>${t('Applica le modifiche senza chiedere')}</span><input type="checkbox" data-k="autoApprove" ${s.autoApprove ? 'checked' : ''} /><i></i></label>
        <p class="hint-text">${t('Ogni modifica viene salvata con un backup e si può annullare dalla chat.')}</p>

        <h4>${t('Ricerca semantica')}</h4>
        ${
          s.provider === 'builtin'
            ? `<p class="hint-text">${t('Con il modello integrato la ricerca usa le parole chiave. Per cercare anche per significato usa Ollama con un modello di embedding.')}</p>`
            : `<label class="field"><span>${t('Modello di embedding')}</span>
          <select data-k="embedModel">${option('', t('Nessuno (solo parole chiave)'), s.embedModel)}${
            s.embedModel && !embedModels.includes(s.embedModel) ? option(s.embedModel, s.embedModel, s.embedModel) : ''
          }${embedModels.map((m) => option(m, m, s.embedModel)).join('')}</select></label>
        <div class="index-status"></div>`
        }

        <h4>${t('Usa il vault da altre app (MCP)')}</h4>
        <p class="hint-text">${t("LM Studio, Claude Desktop e altri client MCP possono usare gli stessi strumenti dell'agente. Incolla questa configurazione nel loro file MCP:")}</p>
        <pre class="mcp-config">…</pre>
        <button class="btn ghost sm" data-copy>${icons.copy}${t('Copia configurazione')}</button>
      </div>`
    this.settingsEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((el) => {
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => this.onSetting(el))
    })
    this.paintIndex()
    this.paintBuiltinList()
  }

  private modelLabel(id: string): string {
    return this.settings.provider === 'builtin' ? (this.builtin?.models.find((m) => m.id === id)?.label ?? id) : id
  }

  /** Built-in provider: the catalog, with download buttons for the models not on disk yet. */
  private paintBuiltinList(): void {
    const el = this.settingsEl.querySelector('.builtin-list')
    const info = this.builtin
    if (!el || !info) return
    const d = this.download
    el.innerHTML = info.models
      .map((m) => {
        const busy = d && d.id === m.id && (d.phase === 'downloading' || d.phase === 'verifying')
        const right = busy
          ? `<span class="muted">${d.phase === 'verifying' ? t('verifico…') : `${Math.floor((d.received / (d.total || 1)) * 100)}%`}</span><button class="link-btn" data-dl-cancel>${t('Pausa')}</button>`
          : m.installed && m.vision
            ? `<span class="muted">${t('scaricato')}</span>`
            : m.installed
              ? // downloaded before the vision file existed: add it on its own
                `<button class="link-btn" data-dl="${m.id}">${t('Aggiungi la lettura delle immagini')} · ${gb(m.visionSize)} GB</button>`
              : `<button class="link-btn" data-dl="${m.id}">${m.partial ? t('Riprendi') : t('Scarica')} · ${gb(m.size)} GB</button>`
        return `<div class="builtin-row"><span>${esc(m.label)}${m.id === info.recommended ? ` <em>${t('consigliato')}</em>` : ''}</span>${right}</div>`
      })
      .join('')
  }

  private onSetting(el: HTMLInputElement | HTMLSelectElement): void {
    const k = el.dataset.k as keyof AiSettings
    const s = this.settings as unknown as Record<string, unknown>
    if (el instanceof HTMLInputElement && el.type === 'checkbox') s[k] = el.checked
    else if (k === 'numCtx' || k === 'temperature') s[k] = Number(el.value)
    else s[k] = el.value
    if (k === 'temperature') el.parentElement!.querySelector('output')!.textContent = Number(el.value).toFixed(2)
    if (k === 'provider') {
      const def = PROVIDERS.find((p) => p.id === el.value)!
      if (!this.settings.baseUrl || PROVIDERS.some((p) => p.url === this.settings.baseUrl)) this.settings.baseUrl = def.url
      this.settings.model = ''
      if (el.value === 'builtin') this.settings.embedModel = ''
    }
    clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(async () => {
      await window.api.aiSaveSettings(this.settings)
      if (k === 'provider' || k === 'baseUrl') await this.refreshStatus()
      else this.paintChip()
      if (k === 'provider') this.paintSettings()
    }, k === 'baseUrl' ? 600 : 150)
  }

  private paintIndex(): void {
    const el = this.settingsEl.querySelector('.index-status')
    if (!el) return
    const s = this.index
    if (!this.settings.embedModel) {
      el.innerHTML = `<p class="hint-text">${t('Senza un modello di embedding la ricerca usa le parole chiave. Per cercare anche per significato installa ad esempio <code>nomic-embed-text</code> in Ollama e sceglilo qui.')}</p>`
      return
    }
    if (!s) return
    const pct = s.running && s.todo ? Math.round(((s.done ?? 0) / s.todo) * 100) : null
    el.innerHTML = `<div class="status-line ${s.error ? 'off' : s.indexed ? 'ok' : ''}">${
      s.error
        ? esc(s.error)
        : s.running
          ? t('Indicizzazione… {pct}%', { pct: pct ?? 0 })
          : s.indexed
            ? t('{done} / {total} note indicizzate', { done: s.indexed, total: s.total })
            : t('Indice non ancora creato')
    }</div>${s.running ? '' : `<button class="btn ghost sm" data-index>${icons.refresh}${s.indexed ? t('Aggiorna indice') : t('Crea indice')}</button>`}`
  }

  private async paintMcp(): Promise<void> {
    const info = await window.api.mcpInfo()
    const pre = this.settingsEl.querySelector('.mcp-config')
    if (pre) pre.textContent = info.config
  }

  private async copyMcp(): Promise<void> {
    const info = await window.api.mcpInfo()
    try {
      await navigator.clipboard.writeText(info.config)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = info.config
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    const btn = this.settingsEl.querySelector('[data-copy]')
    if (btn) btn.innerHTML = `${icons.check}${t('Copiata')}`
  }

  /* ------------------------------------------------------------------ misc */

  private autosize(): void {
    this.input.style.height = 'auto'
    this.input.style.height = Math.min(this.input.scrollHeight, 160) + 'px'
  }

  private scroll(force = false): void {
    const el = this.messagesEl
    if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }
}

function diffHtml(diff: DiffLine[]): string {
  return diff
    .map((d) => `<span class="${d.op === '+' ? 'add' : d.op === '-' ? 'del' : 'ctx'}">${d.op === ' ' ? ' ' : d.op} ${esc(d.text)}</span>`)
    .join('')
}

/** The tail of a streaming text, cut to its last sentence, for a one-line preview. */
function lastSentence(text: string): string {
  const lines = text.trim().split('\n').filter((l) => l.trim())
  const last = (lines[lines.length - 1] ?? '')
    .replace(/\[\[([^\]|#]+)[^\]]*\]\]/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/[*_`#>]/g, '')
    .trim()
  const parts = last.split(/(?<=[.!?:])\s+/).filter(Boolean)
  const tail = parts[parts.length - 1] ?? ''
  return tail.length > 140 ? '…' + tail.slice(-140) : tail
}

/** Avoids touching the DOM (and restarting CSS animations) when nothing changed. */
function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

const gb = (bytes: number): string => (bytes / 1e9).toFixed(1).replace('.', getLang() === 'en' ? '.' : ',')

function duration(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return ''
  if (secs < 60) return `${Math.ceil(secs)} s`
  const min = Math.round(secs / 60)
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
