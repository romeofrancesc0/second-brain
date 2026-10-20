import { join } from 'node:path'
import type { ChatHistoryItem, ChatModelFunctionCall, ChatModelFunctions, Llama, LlamaChat, LlamaContext, LlamaModel } from 'node-llama-cpp'
import { ModelError, type ChatClient, type ChatMessage, type ChatOptions, type ChatResult, type ToolCall } from './llm'
import { catalogModel, installedModels, modelsDir, verifyModel } from './models'

/** Free the model (and the GPU memory) after this long without requests, like Ollama's keep_alive. */
const IDLE_UNLOAD_MS = 2 * 60 * 1000

type NodeLlamaCpp = typeof import('node-llama-cpp')

/** The model loaded in this process: one at a time, shared by every chat. */
interface Loaded {
  path: string
  numCtx: number
  model: LlamaModel
  context: LlamaContext
  chat: LlamaChat
}

let lib: Promise<NodeLlamaCpp> | null = null
let llama: Promise<Llama> | null = null
let loaded: Promise<Loaded> | null = null
let loadedKey = ''
let idleTimer: NodeJS.Timeout | undefined
/** Requests run one after the other: there is a single context sequence. */
let queue: Promise<unknown> = Promise.resolve()

function runtime(): Promise<{ lib: NodeLlamaCpp; llama: Llama }> {
  // ESM-only package: load it lazily so the app starts even where the native binary is missing
  lib ??= import('node-llama-cpp')
  llama ??= lib.then((l) => l.getLlama({ build: 'never', gpu: 'auto', progressLogs: false, logLevel: l.LlamaLogLevel.error }))
  return Promise.all([lib, llama]).then(([lib, llama]) => ({ lib, llama }))
}

async function load(path: string, numCtx: number): Promise<Loaded> {
  const key = `${path}\u0000${numCtx}`
  if (loaded && loadedKey === key) return loaded
  await unload()
  loadedKey = key
  loaded = (async () => {
    const { lib, llama: l } = await runtime()
    const model = await l.loadModel({ modelPath: path })
    const context = await model.createContext({ contextSize: { min: 4096, max: numCtx }, flashAttention: true })
    const chat = new lib.LlamaChat({ contextSequence: context.getSequence() })
    return { path, numCtx, model, context, chat }
  })()
  loaded.catch(() => {
    loaded = null
    loadedKey = ''
  })
  return loaded
}

const NO_MEMORY =
  'Memoria insufficiente per il modello integrato. Chiudi le app che stanno usando un altro modello (Ollama, LM Studio…) o molta memoria, poi riprova.'

/** Loads the model after checking the file (a damaged one is removed) and explains a lack of memory. */
async function loadOrExplain(dataDir: string, id: string, path: string, numCtx: number): Promise<Loaded> {
  // a missing native binary is not the model's fault: let that error through untouched
  const { lib } = await runtime()
  if (!(await verifyModel(dataDir, id)))
    throw new ModelError('no-model', "Il file del modello era danneggiato e l'ho rimosso: scaricalo di nuovo dalle impostazioni dell'agente.")
  try {
    return await load(path, numCtx)
  } catch (err) {
    if (err instanceof lib.InsufficientMemoryError || /insufficient memory|out of memory|failed to allocate/i.test(String(err)))
      throw new ModelError('no-memory', NO_MEMORY)
    throw err
  }
}

async function unload(): Promise<void> {
  const cur = loaded
  loaded = null
  loadedKey = ''
  if (!cur) return
  try {
    const m = await cur
    m.chat.dispose()
    await m.context.dispose()
    await m.model.dispose()
  } catch {
    /* it never loaded */
  }
}

function touch(): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void queued(unload), IDLE_UNLOAD_MS)
  idleTimer.unref?.()
}

function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/** Our provider-neutral history → node-llama-cpp's, where tool results live inside the model turn. */
function toHistory(messages: ChatMessage[]): ChatHistoryItem[] {
  const out: ChatHistoryItem[] = []
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m.content]))
  for (const m of messages) {
    if (m.role === 'system') out.push({ type: 'system', text: m.content })
    else if (m.role === 'user') out.push({ type: 'user', text: m.content })
    else if (m.role === 'assistant') {
      // consecutive assistant messages (split only by tool results) are one model turn
      let last = out[out.length - 1]
      if (last?.type !== 'model') out.push((last = { type: 'model', response: [] }))
      if (m.content) last.response.push(m.content)
      for (const [i, c] of (m.toolCalls ?? []).entries()) {
        const call: ChatModelFunctionCall = {
          type: 'functionCall',
          name: c.name,
          params: c.args,
          result: results.get(c.id) ?? '',
          startsNewChunk: i === 0
        }
        last.response.push(call)
      }
    }
  }
  return out
}

/**
 * node-llama-cpp's grammar makes every property required, so small models fill optional filters
 * with invented values. Let them write null instead, and say so in the description.
 */
function relaxOptional(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined
  if (schema.type !== 'object' || !props) return schema
  const required = new Set((schema.required as string[] | undefined) ?? [])
  const properties = Object.fromEntries(
    Object.entries(props).map(([k, p]) => {
      if (required.has(k) || typeof p.type !== 'string') return [k, p]
      const description = `${p.description ? p.description + '. ' : ''}Optional: null unless really needed.`
      return [k, { ...p, type: [p.type, 'null'], description }]
    })
  )
  return { ...schema, properties }
}

/** The grammar makes the model write every parameter: an empty string means "not given". */
function dropEmpty(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {}
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== null))
}

/** Runs GGUF models in-process with llama.cpp (Metal on macOS, Vulkan/CPU on Windows). */
export class BuiltinClient implements ChatClient {
  constructor(private dataDir: string) {}

  async listModels(): Promise<string[]> {
    const ids = await installedModels(this.dataDir)
    if (!ids.length) throw new ModelError('no-model', 'Nessun modello scaricato.')
    return ids
  }

  chat(o: ChatOptions): Promise<ChatResult> {
    const m = catalogModel(o.model)
    if (!m) return Promise.reject(new ModelError('no-model', `Modello sconosciuto: ${o.model}`))
    const path = join(modelsDir(this.dataDir), m.file)
    return queued(async () => {
      clearTimeout(idleTimer)
      try {
        const { chat } = await loadOrExplain(this.dataDir, m.id, path, o.numCtx)
        o.signal?.throwIfAborted()
        const functions: ChatModelFunctions | undefined = o.tools?.length
          ? Object.fromEntries(o.tools.map((t) => [t.name, { description: t.description, params: relaxOptional(t.parameters) as never }]))
          : undefined
        const result: ChatResult = { content: '', reasoning: '', toolCalls: [] }
        const res = await chat.generateResponse(toHistory(o.messages), {
          functions,
          temperature: o.temperature,
          topP: 0.8,
          topK: 20,
          signal: o.signal,
          stopOnAbortSignal: true,
          // no thinking unless asked: the thought budget is the switch
          budgets: { thoughtTokens: o.think ? Math.floor(o.numCtx / 2) : 0 },
          onResponseChunk: (c) => {
            if (!c.text) return
            if (c.type === 'segment') {
              // with thinking off the model still opens (and closes) an empty thought block
              if (c.segmentType !== 'thought' || !o.think) return
              result.reasoning += c.text
              o.onReasoning?.(c.text)
            } else {
              result.content += c.text
              o.onText?.(c.text)
            }
          }
        })
        result.content = res.response || result.content
        result.toolCalls = (res.functionCalls ?? []).map(
          (c, i): ToolCall => ({ id: `call_${Date.now().toString(36)}_${i}`, name: c.functionName, args: dropEmpty(c.params) })
        )
        return result
      } catch (err) {
        if ((err as Error).name === 'AbortError' || o.signal?.aborted || err instanceof ModelError) throw err
        if (/insufficient memory|out of memory|failed to allocate/i.test(String(err))) throw new ModelError('no-memory', NO_MEMORY)
        throw new ModelError('http', `Modello integrato: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        touch()
      }
    })
  }

  async embed(): Promise<number[][]> {
    throw new ModelError('http', 'Il modello integrato non calcola embedding: la ricerca usa le parole chiave.')
  }
}

/** Frees the model before quitting. */
export function disposeBuiltin(): Promise<void> {
  clearTimeout(idleTimer)
  return unload()
}
