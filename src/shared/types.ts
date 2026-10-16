export type NodeKind = 'note' | 'moc' | 'attachment' | 'unresolved'

export interface GraphNode {
  /** Path relative to the vault root, with extension (unique). */
  id: string
  title: string
  kind: NodeKind
  /** First-level folder inside the vault (e.g. "Neuroni"). */
  folder: string
  area?: string
  corso?: string
  tags: string[]
  /** Group used for colouring and spatial clustering. */
  group: string
  /** Size of the note in words (0 for non-notes). */
  words: number
  mtime: number
}

export interface GraphLink {
  source: string
  target: string
}

export interface VaultGraph {
  vaultPath: string
  vaultName: string
  nodes: GraphNode[]
  links: GraphLink[]
  /** Cached layout positions from a previous session, keyed by node id. */
  positions: Record<string, [number, number, number]>
  scannedAt: number
}

export interface KnownVault {
  path: string
  name: string
  exists: boolean
  lastOpened?: number
}

export interface NoteContent {
  id: string
  /** Note body without the YAML frontmatter. */
  markdown: string
  frontmatter: Record<string, unknown>
  /** Raw link target (as written in the note) -> resolved node id. */
  links: Record<string, string>
  mtime: number
}

export interface AppSettings {
  bloom: number
  linkOpacity: number
  nodeScale: number
  showAttachments: boolean
  showUnresolved: boolean
  showOrphans: boolean
  autoRotate: boolean
  labels: boolean
  pulses: boolean
  /** Haze around the clusters, nebula, dust and bokeh (0 = none). */
  atmosphere: number
  /** Depth of field: out-of-focus neurons go soft (0 = off). */
  dof: number
  /** Film grain (0 = off). */
  grain: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  bloom: 1,
  linkOpacity: 1,
  nodeScale: 1,
  showAttachments: false,
  showUnresolved: false,
  showOrphans: true,
  autoRotate: true,
  labels: true,
  pulses: false,
  atmosphere: 1,
  dof: 0.7,
  grain: 0.5
}

/** Bumped when the defaults change enough that saved appearance settings should be reset. */
export const SETTINGS_VERSION = 3

/* ------------------------------------------------------------------ AI agent */

export type AiProvider = 'ollama' | 'openai'

export interface AiSettings {
  provider: AiProvider
  /** Ollama: http://localhost:11434 — OpenAI-compatible (LM Studio…): http://localhost:1234/v1 */
  baseUrl: string
  model: string
  /** Embedding model for semantic search; empty = keyword search only. */
  embedModel: string
  numCtx: number
  temperature: number
  think: boolean
  /** Apply note changes without asking. Off by default. */
  autoApprove: boolean
  /** Fly the camera to the neurons the agent is working on. */
  followAgent: boolean
}

export const DEFAULT_AI: AiSettings = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: '',
  embedModel: '',
  numCtx: 16384,
  temperature: 0.3,
  think: false,
  autoApprove: false,
  followAgent: true
}

export interface AiStatus {
  ok: boolean
  models: string[]
  error?: string
}

export interface DiffLine {
  op: ' ' | '+' | '-'
  text: string
}

export interface AgentToolCall {
  id: string
  name: string
  /** Short Italian description, e.g. "Cerca «trasformata z»". */
  label: string
  args: Record<string, unknown>
  status: 'running' | 'awaiting' | 'done' | 'error' | 'rejected'
  summary?: string
  ids?: string[]
  /** Present on write tools: what is about to change (or changed). */
  preview?: { path: string; isNew: boolean; diff: DiffLine[] }
  change?: { changeId: string; undone?: boolean }
}

export type AgentEvent =
  | { type: 'start' }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool'; call: AgentToolCall }
  | { type: 'activity'; ids: string[]; mode: 'read' | 'write' }
  | { type: 'notice'; message: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface IndexStatus {
  model: string
  indexed: number
  total: number
  running: boolean
  done?: number
  todo?: number
  error?: string
}

export interface McpInfo {
  config: string
  command: string
  args: string[]
}

export interface SecondBrainApi {
  getKnownVaults(): Promise<KnownVault[]>
  getLastVault(): Promise<string | null>
  chooseVault(): Promise<string | null>
  loadVault(path: string): Promise<VaultGraph>
  readNote(id: string): Promise<NoteContent>
  saveLayout(positions: Record<string, [number, number, number]>): Promise<void>
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<void>
  openInObsidian(id: string): Promise<void>
  openFile(id: string): Promise<void>
  revealInFinder(id: string): Promise<void>
  onVaultChanged(cb: (graph: VaultGraph) => void): () => void

  aiGetSettings(): Promise<AiSettings>
  aiSaveSettings(settings: AiSettings): Promise<void>
  aiStatus(settings?: AiSettings): Promise<AiStatus>
  agentSend(text: string): Promise<void>
  agentStop(): Promise<void>
  agentReset(): Promise<void>
  agentApprove(callId: string, approved: boolean): Promise<void>
  agentUndo(changeId: string): Promise<{ ok: boolean; message: string }>
  onAgentEvent(cb: (e: AgentEvent) => void): () => void
  indexStatus(): Promise<IndexStatus>
  indexBuild(): Promise<void>
  onIndexStatus(cb: (s: IndexStatus) => void): () => void
  mcpInfo(): Promise<McpInfo>
}
