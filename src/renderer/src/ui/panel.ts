import { localeTag, t } from '@shared/i18n'
import type { GraphNode } from '@shared/types'
import { icons } from './icons'
import { decorateCallouts, renderMarkdown, vaultUrl } from './markdown'

export interface PanelContext {
  node: GraphNode
  color: string
  outgoing: GraphNode[]
  backlinks: GraphNode[]
  colorOf: (n: GraphNode) => string
  exists: (id: string) => boolean
}

const KIND_LABEL: Record<GraphNode['kind'], () => string> = {
  note: () => t('Neurone'),
  moc: () => t('Mappa (MOC)'),
  attachment: () => t('Fonte'),
  unresolved: () => t('Non ancora creata')
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

/** Side panel that reads the selected note. */
export class NotePanel {
  onNavigate?: (id: string) => void
  onClose?: () => void
  private el: HTMLElement
  private history: string[] = []
  private cursor = -1
  private navigating = false
  private token = 0

  constructor(el: HTMLElement) {
    this.el = el
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const nodeLink = target.closest<HTMLElement>('[data-node]')
      if (nodeLink) {
        e.preventDefault()
        this.onNavigate?.(nodeLink.dataset.node!)
        return
      }
      const fileLink = target.closest<HTMLElement>('[data-file]')
      if (fileLink) {
        e.preventDefault()
        void window.api.openFile(fileLink.dataset.file!)
        return
      }
      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
      if (action === 'close') this.onClose?.()
      if (action === 'back') this.go(-1)
      if (action === 'forward') this.go(1)
    })
  }

  get isOpen(): boolean {
    return !this.el.classList.contains('hidden')
  }

  hide(): void {
    this.el.classList.add('hidden')
  }

  private go(delta: number): void {
    const next = this.cursor + delta
    if (next < 0 || next >= this.history.length) return
    this.cursor = next
    this.navigating = true
    this.onNavigate?.(this.history[next])
  }

  async show(ctx: PanelContext): Promise<void> {
    const { node } = ctx
    if (this.navigating) this.navigating = false
    else if (this.history[this.cursor] !== node.id) {
      this.history = this.history.slice(0, this.cursor + 1)
      this.history.push(node.id)
      this.cursor = this.history.length - 1
    }
    const token = ++this.token
    this.el.classList.remove('hidden')
    this.el.style.setProperty('--accent', ctx.color)

    const meta: string[] = []
    if (node.area) meta.push(esc(node.area))
    if (node.corso) meta.push(esc(node.corso))
    else if (node.kind !== 'note' && node.kind !== 'moc') meta.push(esc(node.group))
    if (node.words) meta.push(t('{n} parole', { n: node.words.toLocaleString(localeTag()) }))
    if (node.mtime) meta.push(new Date(node.mtime).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', year: 'numeric' }))

    const canBack = this.cursor > 0
    const canFwd = this.cursor < this.history.length - 1
    const isFile = node.kind === 'attachment'
    const isNote = node.kind === 'note' || node.kind === 'moc'

    this.el.innerHTML = `
      <div class="panel-glow"></div>
      <div class="panel-top">
        <div class="nav">
          <button class="icon-btn sm" data-action="back" ${canBack ? '' : 'disabled'} title="${t('Indietro')}">${icons.back}</button>
          <button class="icon-btn sm" data-action="forward" ${canFwd ? '' : 'disabled'} title="${t('Avanti')}">${icons.forward}</button>
        </div>
        <span class="kind-chip"><i></i>${KIND_LABEL[node.kind]()}</span>
        <button class="icon-btn sm" data-action="close" title="${t('Chiudi')} (Esc)">${icons.close}</button>
      </div>
      <div class="panel-scroll">
        <h1 class="note-title">${esc(node.title)}</h1>
        <div class="note-meta">${meta.join('<span class="dot">·</span>')}</div>
        ${node.tags.length ? `<div class="tags">${node.tags.map((tag) => `<span class="tag">#${esc(tag)}</span>`).join('')}</div>` : ''}
        <div class="actions">
          ${isNote ? `<button class="btn" id="open-obsidian">${icons.external}${t('Apri in Obsidian')}</button>` : ''}
          ${isFile ? `<button class="btn" id="open-file">${icons.file}${t('Apri file')}</button>` : ''}
          ${node.kind !== 'unresolved' ? `<button class="btn ghost" id="reveal">${icons.folder}${document.documentElement.dataset.platform === 'mac' ? t('Mostra nel Finder') : t('Mostra nella cartella')}</button>` : ''}
        </div>
        <article class="note-body markdown">${isNote ? '<div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div>' : ''}</article>
        ${this.linkSection(t('Collegamenti in uscita'), icons.arrowOut, ctx.outgoing, ctx)}
        ${this.linkSection(t('Backlink'), icons.arrowIn, ctx.backlinks, ctx)}
      </div>`

    this.el.querySelector('#open-obsidian')?.addEventListener('click', () => void window.api.openInObsidian(node.id))
    this.el.querySelector('#open-file')?.addEventListener('click', () => void window.api.openFile(node.id))
    this.el.querySelector('#reveal')?.addEventListener('click', () => void window.api.revealInFinder(node.id))
    ;(this.el.querySelector('.panel-scroll') as HTMLElement).scrollTop = 0

    const body = this.el.querySelector('.note-body') as HTMLElement
    if (isFile) {
      body.innerHTML = IMAGE_EXT.test(node.id)
        ? `<img class="embed" src="${vaultUrl(node.id)}" alt="" />`
        : `<p class="muted">${t('File sorgente nel vault:')}<br><code>${esc(node.id)}</code></p>`
      return
    }
    if (node.kind === 'unresolved') {
      body.innerHTML = `<p class="muted">${t('Questo concetto è citato da altre note ma non ha ancora una nota sua.')}</p>`
      return
    }
    try {
      const note = await window.api.readNote(node.id)
      if (token !== this.token) return
      const md = note.markdown.replace(new RegExp('^\\s*#\\s+' + escapeRe(node.title) + '\\s*\\n'), '')
      body.innerHTML = renderMarkdown(md, note.links, ctx.exists)
      decorateCallouts(body)
    } catch (err) {
      if (token !== this.token) return
      body.innerHTML = `<p class="muted">${esc(t('Impossibile leggere la nota: {error}', { error: String(err) }))}</p>`
    }
  }

  private linkSection(title: string, icon: string, nodes: GraphNode[], ctx: PanelContext): string {
    if (!nodes.length) return ''
    const sorted = [...nodes].sort((a, b) => kindRank(a) - kindRank(b) || a.title.localeCompare(b.title, localeTag()))
    const items = sorted
      .map((n) => {
        const attr = ctx.exists(n.id) ? `data-node="${esc(n.id)}"` : n.kind === 'attachment' ? `data-file="${esc(n.id)}"` : ''
        return `<li><a ${attr} class="${ctx.exists(n.id) ? '' : 'off'}"><i style="--c:${ctx.colorOf(n)}"></i><span>${esc(n.title)}</span>${
          n.kind === 'attachment' ? `<em>${t('fonte')}</em>` : n.kind === 'moc' ? `<em>MOC</em>` : ''
        }</a></li>`
      })
      .join('')
    return `<section class="links"><h3>${icon}${title}<span class="count">${nodes.length}</span></h3><ul>${items}</ul></section>`
  }
}

const kindRank = (n: GraphNode): number => ({ moc: 0, note: 1, unresolved: 2, attachment: 3 })[n.kind]
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
