import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent, IndexStatus, ModelDownloadProgress, SecondBrainApi, VaultGraph } from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: SecondBrainApi = {
  getLanguage: () => ipcRenderer.invoke('lang:get'),
  setLanguage: (lang) => ipcRenderer.invoke('lang:set', lang),
  setupInfo: () => ipcRenderer.invoke('setup:info'),
  setupFinish: () => ipcRenderer.invoke('setup:finish'),
  openNotices: () => ipcRenderer.invoke('shell:notices'),
  chooseFolder: (title) => ipcRenderer.invoke('folder:choose', title),
  installDemo: (parent) => ipcRenderer.invoke('setup:demo', parent),
  getKnownVaults: () => ipcRenderer.invoke('vaults:known'),
  getLastVault: () => ipcRenderer.invoke('vaults:last'),
  chooseVault: () => ipcRenderer.invoke('vaults:choose'),
  loadVault: (path) => ipcRenderer.invoke('vault:load', path),
  readNote: (id) => ipcRenderer.invoke('note:read', id),
  saveLayout: (positions) => ipcRenderer.invoke('layout:save', positions),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getMode: () => ipcRenderer.invoke('mode:get'),
  setMode: (mode) => ipcRenderer.invoke('mode:set', mode),
  openInObsidian: (id) => ipcRenderer.invoke('shell:obsidian', id),
  openFile: (id) => ipcRenderer.invoke('shell:open', id),
  revealInFinder: (id) => ipcRenderer.invoke('shell:reveal', id),
  onVaultChanged: (cb) => subscribe<VaultGraph>('vault:changed', cb),
  setWindowTheme: (theme) => ipcRenderer.invoke('window:theme', theme),

  aiGetSettings: () => ipcRenderer.invoke('ai:get'),
  aiSaveSettings: (s) => ipcRenderer.invoke('ai:save', s),
  aiStatus: (s) => ipcRenderer.invoke('ai:status', s),
  agentSend: (text) => ipcRenderer.invoke('agent:send', text),
  agentStop: () => ipcRenderer.invoke('agent:stop'),
  agentReset: () => ipcRenderer.invoke('agent:reset'),
  agentApprove: (id, ok) => ipcRenderer.invoke('agent:approve', id, ok),
  agentUndo: (id) => ipcRenderer.invoke('agent:undo', id),
  onAgentEvent: (cb) => subscribe<AgentEvent>('agent:event', cb),
  indexStatus: () => ipcRenderer.invoke('index:status'),
  indexBuild: () => ipcRenderer.invoke('index:build'),
  onIndexStatus: (cb) => subscribe<IndexStatus>('index:status', cb),
  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  builtinModels: () => ipcRenderer.invoke('builtin:models'),
  builtinDownload: (ids) => ipcRenderer.invoke('builtin:download', ids),
  builtinCancel: () => ipcRenderer.invoke('builtin:cancel'),
  onBuiltinProgress: (cb) => subscribe<ModelDownloadProgress>('builtin:progress', cb)
}

contextBridge.exposeInMainWorld('api', api)
