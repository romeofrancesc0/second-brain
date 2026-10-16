import 'katex/dist/katex.min.css'
import './styles.css'
import type { Color } from 'three'
import { DEFAULT_SETTINGS, type AppSettings, type GraphNode, type VaultGraph } from '@shared/types'
import { Brain } from './graph/Brain'
import { AgentPanel } from './ui/agent'
import { buildPalette } from './graph/palette'
import { icons } from './ui/icons'
import { Legend } from './ui/legend'
import { NotePanel } from './ui/panel'
import { SearchPalette } from './ui/search'
import { SettingsPopover } from './ui/settings'
import { Welcome } from './ui/welcome'

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!

let settings: AppSettings = { ...DEFAULT_SETTINGS }
let graph: VaultGraph | null = null
let palette = new Map<string, Color>()
let groupOrder: string[] = []
let nodeById = new Map<string, GraphNode>()
let outgoing = new Map<string, string[]>()
let incoming = new Map<string, string[]>()
let shownIds = new Set<string>()
let titleIndex = new Map<string, string>()
const normalizeTitle = (s: string): string => s.normalize('NFC').trim().toLowerCase()
let brain: Brain

const colorOf = (n: GraphNode): string => '#' + (palette.get(n.group)?.getHexString() ?? 'ffffff')

document.documentElement.dataset.platform = /Mac/.test(navigator.userAgent) ? 'mac' : 'other'

async function boot(): Promise<void> {
  settings = { ...DEFAULT_SETTINGS, ...(await window.api.getSettings()) }
  $('#search-btn').innerHTML = `${icons.search}<span>Cerca un neurone…</span><kbd>⌘K</kbd>`
  $('#agent-btn').innerHTML = `${icons.agent}<span>Agente</span>`
  $('#home-btn').innerHTML = icons.home
  $('#settings-btn').innerHTML = icons.sliders

  brain = new Brain($('#stage'), $('#labels'), settings)
  const panel = new NotePanel($('#panel'))
  const search = new SearchPalette($('#palette'))
  const legend = new Legend($('#legend'))
  const settingsUi = new SettingsPopover($('#settings'), settings)
  const welcome = new Welcome($('#welcome'))
  const agentPanel = new AgentPanel($('#agent'), {
    resolve: (target) => {
      const t = target.replace(/\.md$/i, '')
      if (nodeById.has(t + '.md')) return t + '.md'
      return titleIndex.get(normalizeTitle(t.split('/').pop()!)) ?? null
    },
    exists: (id) => shownIds.has(id),
    openNote: (id) => {
      if (shownIds.has(id)) brain.select(id)
    },
    focusNodes: (ids) => brain.setAgentFocus(ids, true),
    onActivity: (ids, follow) => brain.setAgentFocus(ids, follow),
    onClear: () => brain.setAgentFocus([], false),
    onToggle: (open) => {
      $('#app').classList.toggle('agent-open', open)
      $('#agent-btn').classList.toggle('active', open)
    }
  })

  brain.onSelect = (id) => {
    if (!id) {
      panel.hide()
      return
    }
    const node = nodeById.get(id)
    if (!node) return
    const toNodes = (ids: string[] | undefined): GraphNode[] =>
      (ids ?? []).map((x) => nodeById.get(x)).filter((n): n is GraphNode => !!n)
    void panel.show({
      node,
      color: colorOf(node),
      outgoing: toNodes(outgoing.get(id)),
      backlinks: toNodes(incoming.get(id)),
      colorOf,
      exists: (x) => shownIds.has(x)
    })
  }
  brain.onLayout = (progress, done) => {
    const el = $('#progress')
    el.classList.toggle('hidden', done)
    ;($('#progress .bar i') as HTMLElement).style.width = `${Math.round(progress * 100)}%`
    $('#progress span').textContent = `Formazione della rete neurale… ${Math.round(progress * 100)}%`
    if (done) void window.api.saveLayout(brain.getLayout())
  }

  panel.onNavigate = (id) => {
    if (shownIds.has(id)) brain.select(id)
  }
  panel.onClose = () => brain.select(null, false)
  search.onPick = (id) => brain.select(id)
  legend.onChange = (hidden) => brain.setHiddenGroups(hidden)
  legend.onFocus = (g) => {
    if (brain.selected < 0) brain.setFocusGroup(g)
  }
  settingsUi.onChange = (s, structural) => {
    settings = s
    brain.applySettings(s)
    void window.api.saveSettings(s)
    if (structural && graph) rebuild(false)
  }
  settingsUi.onRelayout = () => {
    settingsUi.hide()
    brain.relayout()
  }
  settingsUi.onChangeVault = () => {
    settingsUi.hide()
    void welcome.show({ closable: !!graph })
  }
  welcome.onOpen = (path) => {
    welcome.hide()
    void openVault(path, welcome)
  }

  $('#search-btn').addEventListener('click', () => search.open())
  $('#agent-btn').addEventListener('click', () => agentPanel.toggle())
  $('#home-btn').addEventListener('click', () => brain.resetView())
  $('#settings-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    settingsUi.toggle()
  })
  $('#vault-btn').addEventListener('click', () => void welcome.show({ closable: !!graph }))
  document.addEventListener('mousedown', (e) => {
    if (settingsUi.isOpen && !(e.target as HTMLElement).closest('#settings, #settings-btn')) settingsUi.hide()
  })

  window.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).tagName === 'INPUT'
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault()
      agentPanel.toggle()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      if (search.isOpen) search.close()
      else search.open()
      return
    }
    if (typing) return
    if (e.key === '/') {
      e.preventDefault()
      search.open()
    } else if (e.key === 'Escape') {
      if (settingsUi.isOpen) settingsUi.hide()
      else if (brain.selected >= 0) brain.select(null, false)
      else brain.setAgentFocus([], false)
    } else if (e.key.toLowerCase() === 'h' && !e.metaKey) {
      brain.resetView()
    } else if (e.key === 'f' && brain.selected >= 0) {
      brain.flyToNode(brain.selected)
    }
  })

  window.api.onVaultChanged((g) => {
    const before = graph?.nodes.filter((n) => n.kind === 'note' || n.kind === 'moc').length ?? 0
    graph = g
    rebuild(false)
    const after = g.nodes.filter((n) => n.kind === 'note' || n.kind === 'moc').length
    const diff = after - before
    toast(diff > 0 ? `Vault aggiornato · +${diff} neuroni` : diff < 0 ? `Vault aggiornato · ${diff} neuroni` : 'Vault aggiornato')
  })

  function rebuild(intro: boolean): void {
    if (!graph) return
    nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
    titleIndex = new Map(
      graph.nodes.filter((n) => n.kind === 'note' || n.kind === 'moc').map((n) => [normalizeTitle(n.title), n.id])
    )
    outgoing = new Map()
    incoming = new Map()
    for (const l of graph.links) {
      ;(outgoing.get(l.source) ?? outgoing.set(l.source, []).get(l.source)!).push(l.target)
      ;(incoming.get(l.target) ?? incoming.set(l.target, []).get(l.target)!).push(l.source)
    }

    // palette and cluster order come from the whole vault, so filters never reshuffle colours
    const counts = new Map<string, number>()
    for (const n of graph.nodes) if (n.kind === 'note' || n.kind === 'moc') counts.set(n.group, (counts.get(n.group) ?? 0) + 1)
    for (const n of graph.nodes) if (!counts.has(n.group)) counts.set(n.group, 0)
    groupOrder = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g)
    palette = buildPalette(groupOrder)

    const include = (n: GraphNode): boolean =>
      n.kind === 'attachment' ? settings.showAttachments : n.kind === 'unresolved' ? settings.showUnresolved : true
    let nodes = graph.nodes.filter(include)
    let ids = new Set(nodes.map((n) => n.id))
    let links = graph.links.filter((l) => ids.has(l.source) && ids.has(l.target))
    if (!settings.showOrphans) {
      const linked = new Set(links.flatMap((l) => [l.source, l.target]))
      nodes = nodes.filter((n) => linked.has(n.id))
      ids = new Set(nodes.map((n) => n.id))
      links = links.filter((l) => ids.has(l.source) && ids.has(l.target))
    }
    shownIds = ids
    const index = new Map(nodes.map((n, i) => [n.id, i]))

    // keep the current layout when rebuilding, fall back to the cached one
    const known = new Map<string, [number, number, number]>()
    if (brain.nodes.length) {
      brain.nodes.forEach((n, i) => known.set(n.id, [brain.positions[i * 3], brain.positions[i * 3 + 1], brain.positions[i * 3 + 2]]))
    } else {
      for (const [id, p] of Object.entries(graph.positions)) known.set(id, p)
    }

    brain.setGraph(
      {
        nodes,
        links: links.map((l) => [index.get(l.source)!, index.get(l.target)!]),
        colors: palette,
        known,
        groups: groupOrder
      },
      intro
    )

    const shownCounts = new Map<string, number>()
    for (const n of nodes) shownCounts.set(n.group, (shownCounts.get(n.group) ?? 0) + 1)
    legend.render(
      groupOrder
        .filter((g) => shownCounts.get(g))
        .map((g) => ({ name: g, count: shownCounts.get(g)!, color: '#' + palette.get(g)!.getHexString() }))
    )
    search.setNodes(
      [...nodes].sort((a, b) => (incoming.get(b.id)?.length ?? 0) - (incoming.get(a.id)?.length ?? 0)),
      colorOf
    )
    const neurons = nodes.filter((n) => n.kind === 'note' || n.kind === 'moc').length
    $('#stats').innerHTML = `<b>${neurons.toLocaleString('it-IT')}</b> neuroni<span class="dot">·</span><b>${links.length.toLocaleString('it-IT')}</b> sinapsi`
    $('#vault-btn').innerHTML = `${icons.vault}<span>${esc(graph.vaultName)}</span>`
    $('#app').classList.add('ready')
  }

  async function openVault(path: string, w: Welcome): Promise<void> {
    $('#progress').classList.remove('hidden')
    $('#progress span').textContent = 'Lettura del vault…'
    try {
      const g = await window.api.loadVault(path)
      const first = !graph || graph.vaultPath !== g.vaultPath
      if (first) {
        brain.select(null, false)
        brain.nodes = []
      }
      graph = g
      rebuild(first)
    } catch (err) {
      $('#progress').classList.add('hidden')
      void w.show({ error: `Impossibile aprire il vault: ${String(err)}` })
    }
  }

  // the shortcut hints fade away after a while or at the first interaction
  const hideHint = (): void => $('.hint').classList.add('gone')
  setTimeout(hideHint, 9000)
  window.addEventListener('keydown', hideHint, { once: true })
  $('#stage').addEventListener('pointerdown', hideHint, { once: true })

  const last = await window.api.getLastVault()
  if (last) void openVault(last, welcome)
  else void welcome.show()
}

let toastTimer: number | undefined
function toast(text: string): void {
  const el = $('#toast')
  el.textContent = text
  el.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => el.classList.add('hidden'), 3200)
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

void boot()

// exposed for debugging from devtools / automated capture
declare global {
  interface Window {
    __brain?: () => Brain
  }
}
window.__brain = () => brain
