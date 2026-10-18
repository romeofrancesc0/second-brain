import 'katex/dist/katex.min.css'
import './styles.css'
import type { Color } from 'three'
import { DEFAULT_SETTINGS, type AppSettings, type GraphNode, type VaultGraph, type ViewMode } from '@shared/types'
import { Brain } from './graph/Brain'
import { AgentPanel } from './ui/agent'
import { buildPalette } from './graph/palette'
import { VIEWS, isLight, onSystemToneChange } from './graph/views'
import { Dock } from './ui/dock'
import { icons } from './ui/icons'
import { Legend } from './ui/legend'
import { NotePanel } from './ui/panel'
import { SearchPalette } from './ui/search'
import { SettingsDialog } from './ui/settings'
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
  const mod = document.documentElement.dataset.platform === 'mac' ? '⌘' : 'Ctrl '
  $('#search-btn').innerHTML = `${icons.search}<span>Cerca un neurone…</span><kbd>${mod}K</kbd>`
  $('#agent-btn').innerHTML = `${icons.agent}<span>Agente</span>`
  $('#settings-btn').innerHTML = icons.sliders
  applyTheme()

  brain = new Brain($('#stage'), $('#labels'), settings)
  const panel = new NotePanel($('#panel'))
  const search = new SearchPalette($('#palette'))
  const legend = new Legend($('#legend'))
  const settingsUi = new SettingsDialog($('#settings'), settings)
  const welcome = new Welcome($('#welcome'))
  const dock = new Dock($('#dock'))
  paintHint()
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
    $('#app').classList.toggle('panel-open', !!id)
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
    if (done) {
      const layout = brain.getLayout()
      if (graph) graph.positions = layout
      void window.api.saveLayout(layout)
    }
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
  settingsUi.onChange = (s, structural) => commit(s, structural)
  settingsUi.onRelayout = () => {
    settingsUi.close()
    brain.relayout()
  }
  settingsUi.onChangeVault = () => {
    settingsUi.close()
    void welcome.show({ closable: !!graph })
  }
  settingsUi.onOpenAgent = () => {
    settingsUi.close()
    agentPanel.openSettings()
  }
  dock.onZoom = (f) => brain.zoom(f)
  dock.onHome = () => brain.resetView()
  onSystemToneChange(() => {
    if (settings.view === 'minimal' && settings.tone === 'system') {
      applyTheme()
      brain.applySettings(settings)
      settingsUi.update(settings)
    }
  })

  /** Applies new settings everywhere; rebuilds the graph when nodes or the layout shape change. */
  function commit(s: AppSettings, structural = false): void {
    const prev = settings
    settings = s
    const restyle = prev.view !== s.view || isLight(prev) !== isLight(s)
    const apply = (): void => {
      applyTheme()
      brain.applySettings(s)
      if (structural && graph) rebuild(false)
      paintHint()
    }
    // a short fade hides the swap of shaders and colours
    if (restyle && graph) {
      $('#stage').classList.add('fading')
      $('#labels').classList.add('fading')
      setTimeout(() => {
        apply()
        requestAnimationFrame(() => {
          $('#stage').classList.remove('fading')
          $('#labels').classList.remove('fading')
        })
      }, 160)
    } else apply()
    void window.api.saveSettings(s)
  }

  function setView(view: ViewMode): void {
    if (view === settings.view) return
    commit({ ...settings, view })
    settingsUi.update(settings)
    toast(`Vista ${VIEWS.find((v) => v.id === view)!.name}`)
  }
  welcome.onOpen = (path) => {
    welcome.hide()
    void openVault(path, welcome)
  }

  $('#search-btn').addEventListener('click', () => search.open())
  $('#agent-btn').addEventListener('click', () => agentPanel.toggle())
  $('#settings-btn').addEventListener('click', () => settingsUi.toggle())
  $('#vault-btn').addEventListener('click', () => void welcome.show({ closable: !!graph }))

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
    const cmd = e.metaKey || e.ctrlKey
    if (cmd && e.key.toLowerCase() === 'j') {
      e.preventDefault()
      settingsUi.close()
      agentPanel.toggle()
      return
    }
    if (cmd && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      settingsUi.close()
      if (search.isOpen) search.close()
      else search.open()
      return
    }
    if (cmd && e.key === ',') {
      e.preventDefault()
      settingsUi.toggle()
      return
    }
    if (e.key === 'Escape' && settingsUi.isOpen) {
      settingsUi.close()
      return
    }
    if (typing || cmd || e.altKey) return
    if (settingsUi.isOpen) return
    const view = VIEWS.find((v) => v.key === e.key)
    if (view) {
      setView(view.id)
    } else if (e.key === '/') {
      e.preventDefault()
      search.open()
    } else if (e.key === '?') {
      settingsUi.open('keys')
    } else if (e.key === '+' || e.key === '=') {
      brain.zoom(0.7)
    } else if (e.key === '-') {
      brain.zoom(1 / 0.7)
    } else if (e.key === 'Escape') {
      if (brain.selected >= 0) brain.select(null, false)
      else brain.setAgentFocus([], false)
    } else if (e.key.toLowerCase() === 'h') {
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
      const p = brain.layoutPositions
      brain.nodes.forEach((n, i) => known.set(n.id, [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]))
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
    settingsUi.setVault(graph.vaultName, graph.vaultPath, neurons, links.length)
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
  const hideHint = (): void => $('#hint').classList.add('gone')
  setTimeout(hideHint, 9000)
  window.addEventListener('keydown', hideHint, { once: true })
  $('#stage').addEventListener('pointerdown', hideHint, { once: true })

  const last = await window.api.getLastVault()
  if (last) void openVault(last, welcome)
  else void welcome.show()
}

/** Interface theme (light only in the minimal view), view-specific styling and accent colour. */
function applyTheme(): void {
  const root = document.documentElement
  const light = isLight(settings)
  root.dataset.theme = light ? 'light' : 'dark'
  root.dataset.look = settings.view
  root.style.setProperty('--brand', settings.accent)
  void window.api.setWindowTheme(light ? 'light' : 'dark')
}

function paintHint(): void {
  const el = $('#hint')
  el.classList.toggle('off', !settings.hints)
  const items: [string, string][] = [
    ['trascina', 'ruota'],
    ['scroll', 'zoom'],
    ['W A S D', 'vola'],
    ['click', 'apri neurone'],
    [`${document.documentElement.dataset.platform === 'mac' ? '⌘' : 'Ctrl'} ,`, 'impostazioni'],
    ['?', 'scorciatoie']
  ]
  el.innerHTML = items.map(([k, label]) => `<span><kbd>${k}</kbd> ${label}</span>`).join('')
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
