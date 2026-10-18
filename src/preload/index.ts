import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentEvent, IndexStatus, SecondBrainApi, VaultGraph } from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: SecondBrainApi = {
  getKnownVaults: () => ipcRenderer.invoke('vaults:known'),
  getLastVault: () => ipcRenderer.invoke('vaults:last'),
  chooseVault: () => ipcRenderer.invoke('vaults:choose'),
  loadVault: (path) => ipcRenderer.invoke('vault:load', path),
  readNote: (id) => ipcRenderer.invoke('note:read', id),
  saveLayout: (positions, flat) => ipcRenderer.invoke('layout:save', positions, flat),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
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
  mcpInfo: () => ipcRenderer.invoke('mcp:info')
}

contextBridge.exposeInMainWorld('api', api)
