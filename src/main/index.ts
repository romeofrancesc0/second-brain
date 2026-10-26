import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { getLang, langFromLocale, setLang, t, type Lang } from '@shared/i18n'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs, watch, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_MODE, DEFAULT_SETTINGS, MODES, SETTINGS_VERSION, type AiSettings, type AppMode, type AppSettings, type KnownVault, type VaultGraph } from '@shared/types'
import { VaultKnowledge } from './agent/knowledge'
import { obsidianConfigPath } from './platform'
import { registerAgent } from './agentIpc'
import { resolveNoteLinks, safeVaultPath, scanVault, splitFrontmatter, type Resolver } from './vault'

// Dev/testing: run against a separate data folder (config, layout cache, agent backups).
if (process.env.SBV_USER_DATA) app.setPath('userData', process.env.SBV_USER_DATA)

protocol.registerSchemesAsPrivileged([
  { scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let mainWindow: BrowserWindow | null = null
let currentVault: string | null = null
let currentResolver: Resolver | null = null
let knowledge: VaultKnowledge | null = null
let watcher: FSWatcher | null = null
let agent: ReturnType<typeof registerAgent> | null = null

const configPath = (): string => join(app.getPath('userData'), 'config.json')
const layoutPath = (vault: string): string =>
  join(app.getPath('userData'), 'layouts', createHash('sha1').update(vault).digest('hex') + '.json')

interface Config {
  lastVault?: string
  settings?: Partial<AppSettings>
  settingsVersion?: number
  ai?: Partial<AiSettings>
  mode?: AppMode
  language?: Lang
  /** The first-run wizard was completed or skipped. */
  setupDone?: boolean
}

const modeOf = (m: unknown): AppMode => (MODES.some((x) => x.id === m) ? (m as AppMode) : DEFAULT_MODE)

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Writes to a temporary file and renames it: a reader never sees a half-written file. */
async function writeJson(path: string, data: unknown): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data))
  await fs.rename(tmp, path)
}

/** Config updates run one at a time, so two close saves (e.g. mode and view) never lose each other's fields. */
let configQueue: Promise<unknown> = Promise.resolve()
function updateConfig(patch: Partial<Config>): Promise<void> {
  const run = configQueue.then(async () => {
    const cfg = await readJson<Config>(configPath(), {})
    await writeJson(configPath(), { ...cfg, ...patch })
  })
  configQueue = run.catch(() => undefined)
  return run
}

/** The saved language, or the system's when the user never chose one. */
async function getConfiguredLang(): Promise<Lang> {
  const cfg = await readJson<Config>(configPath(), {})
  return cfg.language ?? langFromLocale(app.getLocale())
}

async function knownVaults(): Promise<KnownVault[]> {
  const obsidianCfg = obsidianConfigPath()
  const data = await readJson<{ vaults?: Record<string, { path: string; ts?: number }> }>(obsidianCfg, {})
  const cfg = await readJson<Config>(configPath(), {})
  const list = new Map<string, KnownVault>()
  for (const v of Object.values(data.vaults ?? {})) {
    list.set(v.path, { path: v.path, name: basename(v.path), exists: existsSync(v.path), lastOpened: v.ts })
  }
  if (cfg.lastVault && !list.has(cfg.lastVault)) {
    list.set(cfg.lastVault, { path: cfg.lastVault, name: basename(cfg.lastVault), exists: existsSync(cfg.lastVault) })
  }
  return [...list.values()].sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0))
}

async function loadGraph(vault: string): Promise<VaultGraph> {
  const scan = await scanVault(vault)
  const { graph, resolver } = scan
  currentResolver = resolver
  knowledge = new VaultKnowledge(vault, scan)
  agent?.onScan(knowledge)
  const positions = await readJson<VaultGraph['positions']>(layoutPath(vault), {})
  return { ...graph, positions }
}

function watchVault(vault: string): void {
  watcher?.close()
  let timer: NodeJS.Timeout | null = null
  try {
    watcher = watch(vault, { recursive: true }, (_event, filename) => {
      if (!filename || filename.split(/[\\/]/).some((part) => part.startsWith('.'))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        if (currentVault !== vault || !mainWindow) return
        try {
          mainWindow.webContents.send('vault:changed', await loadGraph(vault))
        } catch (err) {
          console.error('Rescan failed', err)
        }
      }, 900)
    })
  } catch (err) {
    console.error('Watch failed', err)
  }
}

/** Re-reads the vault right away (used after the agent edits a note) and updates the UI. */
async function rescanNow(): Promise<void> {
  if (!currentVault) return
  const graph = await loadGraph(currentVault)
  mainWindow?.webContents.send('vault:changed', graph)
}

/** The demo vault shipped with the app: in the resources once packaged, under resources/ in development. */
function demoVaultSource(lang: Lang): string {
  const packaged = join(process.resourcesPath ?? '', 'demo-vault', lang)
  return existsSync(packaged) ? packaged : join(app.getAppPath(), 'resources', 'demo-vault', lang)
}

/** Copies the demo vault into a folder of its own inside `parent`, never over an existing one. */
async function installDemoVault(parent: string, lang: Lang): Promise<string> {
  const name = t('Second Brain - Demo')
  let dest = join(parent, name)
  for (let n = 2; existsSync(dest); n++) dest = join(parent, `${name} ${n}`)
  await fs.cp(demoVaultSource(lang), dest, { recursive: true, errorOnExist: true })
  return dest
}

function registerIpc(): void {
  agent = registerAgent({
    window: () => mainWindow,
    vault: () => currentVault,
    knowledge: () => knowledge,
    rescan: rescanNow,
    loadAi: async () => (await readJson<Config>(configPath(), {})).ai,
    saveAi: (ai) => updateConfig({ ai }),
    loadMode: async () => modeOf((await readJson<Config>(configPath(), {})).mode)
  })
  ipcMain.handle('lang:get', async () => getConfiguredLang())
  ipcMain.handle('lang:set', async (_e, lang: Lang) => {
    setLang(lang)
    await updateConfig({ language: lang })
  })
  ipcMain.handle('setup:info', async () => {
    const cfg = await readJson<Config>(configPath(), {})
    return { first: !cfg.setupDone && !cfg.lastVault, defaultFolder: app.getPath('documents') }
  })
  ipcMain.handle('setup:finish', () => updateConfig({ setupDone: true }))
  ipcMain.handle('folder:choose', async (_e, title: string) => {
    const res = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('shell:notices', async () => {
    const packaged = join(process.resourcesPath ?? '', 'THIRD_PARTY_NOTICES.md')
    await shell.openPath(existsSync(packaged) ? packaged : join(app.getAppPath(), 'resources', 'THIRD_PARTY_NOTICES.md'))
  })
  ipcMain.handle('setup:demo', (_e, parent: string) => installDemoVault(parent, getLang()))
  ipcMain.handle('mode:get', async () => modeOf((await readJson<Config>(configPath(), {})).mode))
  ipcMain.handle('mode:set', async (_e, m: AppMode) => {
    const mode = modeOf(m)
    agent?.setMode(mode)
    await updateConfig({ mode })
  })
  ipcMain.handle('vaults:known', () => knownVaults())
  ipcMain.handle('vaults:last', async () => (await readJson<Config>(configPath(), {})).lastVault ?? null)
  ipcMain.handle('vaults:choose', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: t('Scegli la cartella del vault'),
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('vault:load', async (_e, vault: string) => {
    const graph = await loadGraph(vault)
    currentVault = vault
    await updateConfig({ lastVault: vault })
    watchVault(vault)
    return graph
  })
  ipcMain.handle('note:read', async (_e, id: string) => {
    if (!currentVault) throw new Error(t('Nessun vault aperto'))
    const abs = safeVaultPath(currentVault, id)
    const [src, stat] = await Promise.all([fs.readFile(abs, 'utf8'), fs.stat(abs)])
    const { frontmatter, body } = splitFrontmatter(src)
    const links = currentResolver ? resolveNoteLinks(currentResolver, id, src) : {}
    return { id, markdown: body, frontmatter, links, mtime: stat.mtimeMs }
  })
  ipcMain.handle('layout:save', async (_e, positions: VaultGraph['positions']) => {
    if (currentVault) await writeJson(layoutPath(currentVault), positions)
  })
  ipcMain.handle('window:theme', (_e, theme: 'dark' | 'light') => {
    if (!mainWindow) return
    const bg = theme === 'light' ? '#f4f4f1' : '#090b11'
    mainWindow.setBackgroundColor(bg)
    if (process.platform !== 'darwin') {
      mainWindow.setTitleBarOverlay({ color: bg, symbolColor: theme === 'light' ? '#4a4f5c' : '#aeb3c2', height: 56 })
    }
  })
  ipcMain.handle('settings:get', async () => {
    const cfg = await readJson<Config>(configPath(), {})
    // appearance defaults changed: keep only what is not about the look
    if ((cfg.settingsVersion ?? 1) < SETTINGS_VERSION) {
      const { showAttachments, showUnresolved, showOrphans, labels, autoRotate } = { ...DEFAULT_SETTINGS, ...cfg.settings }
      return { ...DEFAULT_SETTINGS, showAttachments, showUnresolved, showOrphans, labels, autoRotate }
    }
    return { ...DEFAULT_SETTINGS, ...cfg.settings }
  })
  ipcMain.handle('settings:save', (_e, settings: AppSettings) => updateConfig({ settings, settingsVersion: SETTINGS_VERSION }))
  ipcMain.handle('shell:obsidian', async (_e, id: string) => {
    if (!currentVault) return
    await shell.openExternal('obsidian://open?path=' + encodeURIComponent(safeVaultPath(currentVault, id)))
  })
  ipcMain.handle('shell:open', async (_e, id: string) => {
    if (currentVault) await shell.openPath(safeVaultPath(currentVault, id))
  })
  ipcMain.handle('shell:reveal', (_e, id: string) => {
    if (currentVault) shell.showItemInFolder(safeVaultPath(currentVault, id))
  })
}

function registerVaultProtocol(): void {
  // vault://file/<path relative to vault>: serves images embedded in notes.
  protocol.handle('vault', (request) => {
    if (!currentVault) return new Response('No vault', { status: 404 })
    try {
      const rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
      return net.fetch(pathToFileURL(safeVaultPath(currentVault, rel)).toString())
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Second Brain',
    backgroundColor: '#0b0d13',
    // macOS: traffic lights inside our own title bar; Windows/Linux: frameless bar with native buttons overlaid
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 20 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#090b11', symbolColor: '#aeb3c2', height: 56 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // automated screenshots must keep rendering even when the window is covered
      backgroundThrottling: !process.env.SBV_CAPTURE_STEPS
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (process.env.SBV_CAPTURE_STEPS) runCaptureSteps(mainWindow)
}

/**
 * Dev-only: SBV_CAPTURE_STEPS='[{"wait":8000,"shot":"/tmp/a.png"},{"js":"...","wait":2000,"shot":"/tmp/b.png"}]'
 * runs scripts in the renderer and saves screenshots, then quits. Used to verify rendering.
 */
function runCaptureSteps(win: BrowserWindow): void {
  const steps = JSON.parse(process.env.SBV_CAPTURE_STEPS!) as { js?: string; wait?: number; shot?: string }[]
  win.webContents.on('console-message', (...args: unknown[]) => {
    const e = args[0] as { message?: string }
    console.log('[renderer]', (args[2] as string | undefined) ?? e.message)
  })
  win.webContents.once('did-finish-load', async () => {
    for (const step of steps) {
      if (step.js) {
        try {
          console.log('[eval]', JSON.stringify(await win.webContents.executeJavaScript(step.js)))
        } catch (err) {
          console.log('[eval error]', err)
        }
      }
      await new Promise((r) => setTimeout(r, step.wait ?? 1000))
      if (step.shot) {
        const img = await win.webContents.capturePage()
        await fs.writeFile(step.shot, img.toPNG())
        console.log('[shot]', step.shot)
      }
    }
    app.quit()
  })
}

app.whenReady().then(async () => {
  app.setName('Second Brain')
  setLang(await getConfiguredLang())
  registerIpc()
  registerVaultProtocol()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  watcher?.close()
  if (process.platform !== 'darwin' || process.env.SBV_CAPTURE_STEPS) app.quit()
})
