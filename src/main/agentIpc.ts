import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { DEFAULT_AI, type AgentEvent, type AiSettings, type AiStatus, type IndexStatus, type McpInfo, type ModelDownloadProgress } from '@shared/types'
import { AgentSession } from './agent/agent'
import { disposeBuiltin } from './agent/builtin'
import { EmbeddingIndex } from './agent/embeddings'
import type { VaultKnowledge } from './agent/knowledge'
import { createClient } from './agent/llm'
import { downloadModel, modelInfo } from './agent/models'
import { readVaultRules } from './agent/prompt'
import { undoChange } from './agent/tools'

export interface AgentDeps {
  window(): BrowserWindow | null
  vault(): string | null
  knowledge(): VaultKnowledge | null
  /** Re-scan the vault now and push the new graph to the UI. */
  rescan(): Promise<void>
  loadAi(): Promise<Partial<AiSettings> | undefined>
  saveAi(s: AiSettings): Promise<void>
}

/** Wires the local-model agent (chat, tools, semantic index, MCP info) to the renderer. */
export function registerAgent(deps: AgentDeps): { onScan(k: VaultKnowledge): void } {
  const dataDir = app.getPath('userData')
  let settings: AiSettings = { ...DEFAULT_AI }
  const ready = deps.loadAi().then((s) => (settings = { ...DEFAULT_AI, ...s }))

  let index: EmbeddingIndex | null = null
  let indexKey = ''
  let indexing: AbortController | null = null
  let indexStatus: IndexStatus = { model: '', indexed: 0, total: 0, running: false }

  const send = (channel: string, payload: unknown): void => deps.window()?.webContents.send(channel, payload)
  const emit = (e: AgentEvent): void => send('agent:event', e)
  const noteCount = (): number => deps.knowledge()?.notes.size ?? 0
  const pushIndexStatus = (patch: Partial<IndexStatus> = {}): void => {
    indexStatus = { ...indexStatus, model: settings.embedModel, indexed: index?.size ?? 0, total: noteCount(), ...patch }
    send('index:status', indexStatus)
  }

  async function ensureIndex(): Promise<void> {
    const vault = deps.vault()
    const key = `${vault}\u0000${settings.embedModel}`
    if (!vault || !settings.embedModel) {
      index = null
      indexKey = key
    } else if (key !== indexKey) {
      indexKey = key
      index = await EmbeddingIndex.load(dataDir, vault, settings.embedModel)
    }
    const k = deps.knowledge()
    if (k) k.embeddings = index
  }

  async function buildIndex(): Promise<void> {
    const vault = deps.vault()
    const k = deps.knowledge()
    if (!vault || !k || !settings.embedModel || indexing) return
    indexing = new AbortController()
    const client = createClient(settings, dataDir)
    pushIndexStatus({ running: true, error: undefined, done: 0, todo: undefined })
    try {
      const built = await EmbeddingIndex.build(
        index,
        settings.embedModel,
        [...k.notes.values()],
        (texts) => client.embed(settings.embedModel, texts, indexing?.signal),
        (done, todo) => pushIndexStatus({ running: true, done, todo }),
        indexing.signal
      )
      await built.save(dataDir, vault)
      index = built
      indexKey = `${vault}\u0000${settings.embedModel}`
      const cur = deps.knowledge()
      if (cur) cur.embeddings = index
      pushIndexStatus({ running: false })
    } catch (err) {
      pushIndexStatus({ running: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      indexing = null
    }
  }

  const session = new AgentSession({
    emit,
    settings: () => settings,
    rules: async () => {
      const vault = deps.vault()
      return vault ? readVaultRules(vault) : ''
    },
    context: () => {
      const vault = deps.vault()
      if (!vault || !deps.knowledge()) return null
      return {
        vaultPath: vault,
        dataDir,
        knowledge: () => deps.knowledge()!,
        refresh: () => deps.rescan(),
        embedQuery: async (text) => {
          if (!index || !settings.embedModel) return null
          try {
            const [v] = await createClient(settings, dataDir).embed(settings.embedModel, [text])
            return Float32Array.from(v)
          } catch {
            return null
          }
        }
      }
    }
  })

  ipcMain.handle('ai:get', async () => {
    await ready
    return settings
  })
  ipcMain.handle('ai:save', async (_e, s: AiSettings) => {
    const reset = s.model !== settings.model || s.baseUrl !== settings.baseUrl || s.provider !== settings.provider
    settings = { ...DEFAULT_AI, ...s }
    await deps.saveAi(settings)
    if (reset) session.reset()
    await ensureIndex()
    pushIndexStatus()
  })
  ipcMain.handle('ai:status', async (_e, s?: AiSettings): Promise<AiStatus> => {
    await ready
    try {
      const models = await createClient(s ?? settings, dataDir).listModels(AbortSignal.timeout(4000))
      return { ok: true, models }
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('agent:send', async (_e, text: string) => {
    await ready
    await ensureIndex()
    void session.send(text)
  })
  ipcMain.handle('agent:stop', () => session.stop())
  ipcMain.handle('agent:reset', () => session.reset())
  ipcMain.handle('agent:approve', (_e, callId: string, ok: boolean) => session.approve(callId, ok))
  ipcMain.handle('agent:undo', async (_e, changeId: string) => {
    const vault = deps.vault()
    if (!vault) return { ok: false, message: 'Nessun vault aperto' }
    try {
      const res = await undoChange(dataDir, vault, changeId, (abs) => shell.trashItem(abs))
      await deps.rescan()
      return res
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('index:status', async () => {
    await ready
    await ensureIndex()
    pushIndexStatus()
    return indexStatus
  })
  ipcMain.handle('index:build', () => buildIndex())
  let download: AbortController | null = null
  ipcMain.handle('builtin:models', () => modelInfo(dataDir))
  ipcMain.handle('builtin:download', async (_e, id: string) => {
    if (download) return { ok: false, error: 'Un download è già in corso.' }
    download = new AbortController()
    try {
      await downloadModel(dataDir, id, (p) => send('builtin:progress', p), download.signal)
      return { ok: true }
    } catch (err) {
      const paused = download.signal.aborted
      const error = paused ? 'Download in pausa: riprendi quando vuoi.' : err instanceof Error ? err.message : String(err)
      send('builtin:progress', { id, received: 0, total: 0, phase: paused ? 'paused' : 'error', error } satisfies ModelDownloadProgress)
      return { ok: false, error }
    } finally {
      download = null
    }
  })
  ipcMain.handle('builtin:cancel', () => download?.abort())
  app.on('will-quit', () => {
    download?.abort()
    void disposeBuiltin()
  })
  ipcMain.handle('mcp:info', (): McpInfo => {
    const script = join(app.getAppPath(), 'out', 'main', 'mcp.js')
    const args = [script, '--vault', deps.vault() ?? '/percorso/del/vault', '--data-dir', dataDir]
    const config = JSON.stringify(
      { mcpServers: { 'second-brain': { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' } } } },
      null,
      2
    )
    return { config, command: process.execPath, args }
  })

  return {
    onScan: (k) => {
      k.embeddings = index
      void ensureIndex().then(() => {
        // keep the semantic index fresh when a few notes change (e.g. edits made by the agent)
        const stale = index ? index.stale(k.notes.values()).length : 0
        if (index && !indexing && stale > 0 && stale <= 50) void buildIndex()
      })
    }
  }
}
