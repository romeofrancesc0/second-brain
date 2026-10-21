import type { AiSettings } from '@shared/types'
import { secondBrainDataDir } from '../platform'
import { BuiltinClient } from './builtin'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  /** Pictures for vision models, as data URIs (user messages only). */
  images?: string[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatOptions {
  model: string
  messages: ChatMessage[]
  tools?: ToolSpec[]
  temperature: number
  numCtx: number
  think: boolean
  signal?: AbortSignal
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
}

export interface ChatResult {
  content: string
  reasoning: string
  toolCalls: ToolCall[]
}

export interface ChatClient {
  listModels(signal?: AbortSignal): Promise<string[]>
  chat(opts: ChatOptions): Promise<ChatResult>
  embed(model: string, texts: string[], signal?: AbortSignal): Promise<number[][]>
  /** Whether this model can look at images (sent as `ChatMessage.images`). */
  canSee?(model: string): Promise<boolean>
}

export type ModelErrorCode = 'connection' | 'no-tools' | 'no-think' | 'no-model' | 'no-memory' | 'http'

export class ModelError extends Error {
  constructor(
    readonly code: ModelErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** How long Ollama keeps a model in (GPU) memory after the last request. */
const OLLAMA_KEEP_ALIVE = '2m'

/** `dataDir` is where the built-in provider keeps its downloaded models. */
export function createClient(s: Pick<AiSettings, 'provider' | 'baseUrl'>, dataDir = secondBrainDataDir()): ChatClient {
  if (s.provider === 'builtin') return new BuiltinClient(dataDir)
  const base = s.baseUrl.replace(/\/+$/, '')
  return s.provider === 'ollama' ? new OllamaClient(base) : new OpenAICompatClient(base)
}

async function request(url: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ModelError('connection', `Impossibile raggiungere il server del modello (${url}). È avviato?`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = text
    try {
      const j = JSON.parse(text) as { error?: string | { message?: string } }
      message = typeof j.error === 'string' ? j.error : (j.error?.message ?? text)
    } catch {
      /* plain text */
    }
    if (/does not support tools|tool.*not supported|tools? (are|is) not supported/i.test(message)) throw new ModelError('no-tools', message)
    if (/does not support think/i.test(message)) throw new ModelError('no-think', message)
    if (res.status === 404 && /model/i.test(message)) throw new ModelError('no-model', message)
    throw new ModelError('http', `Errore ${res.status}: ${message || res.statusText}`)
  }
  return res
}

async function* lines(res: Response): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield line
    }
  }
  if (buf.trim()) yield buf.trim()
}

/** Splits <think>…</think> blocks that some models emit inside the normal content stream. */
class ThinkSplitter {
  private inThink = false
  private pending = ''

  constructor(
    private onText: (s: string) => void,
    private onThink: (s: string) => void
  ) {}

  push(delta: string): void {
    let s = this.pending + delta
    this.pending = ''
    while (s) {
      const tag = this.inThink ? '</think>' : '<think>'
      const at = s.indexOf(tag)
      if (at >= 0) {
        this.emit(s.slice(0, at))
        this.inThink = !this.inThink
        s = s.slice(at + tag.length)
        continue
      }
      // keep a possible partial tag for the next chunk
      const keep = partialSuffix(s, tag)
      this.emit(s.slice(0, s.length - keep))
      this.pending = s.slice(s.length - keep)
      break
    }
  }

  flush(): void {
    this.emit(this.pending)
    this.pending = ''
  }

  private emit(s: string): void {
    if (!s) return
    if (this.inThink) this.onThink(s)
    else this.onText(s)
  }
}

function partialSuffix(s: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(s.length - k))) return k
  return 0
}

/* ----------------------------------------------------------------- Ollama */

class OllamaClient implements ChatClient {
  constructor(private base: string) {}

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await request(this.base + '/api/tags', { signal })
    const j = (await res.json()) as { models?: { name: string }[] }
    return (j.models ?? []).map((m) => m.name).sort()
  }

  async chat(o: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: o.model,
      stream: true,
      messages: o.messages.map((m) => {
        if (m.role === 'assistant')
          return {
            role: 'assistant',
            content: m.content,
            ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {})
          }
        if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.toolName }
        if (m.images?.length) return { role: m.role, content: m.content, images: m.images.map((u) => u.replace(/^data:[^,]*,/, '')) }
        return { role: m.role, content: m.content }
      }),
      options: { num_ctx: o.numCtx, temperature: o.temperature },
      // free the GPU after 2 idle minutes: every new question loads the model again (a few seconds)
      keep_alive: OLLAMA_KEEP_ALIVE
    }
    if (o.tools?.length) body.tools = o.tools.map((t) => ({ type: 'function', function: t }))
    // thinking models think by default: say it explicitly either way
    body.think = o.think
    const post = (): Promise<Response> =>
      request(this.base + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: o.signal
      })
    let res: Response
    try {
      res = await post()
    } catch (err) {
      // models without a thinking mode may refuse the field altogether
      if (!(err instanceof ModelError && err.code === 'no-think' && !o.think)) throw err
      delete body.think
      res = await post()
    }
    const result: ChatResult = { content: '', reasoning: '', toolCalls: [] }
    const split = new ThinkSplitter(
      (t) => {
        result.content += t
        o.onText?.(t)
      },
      (t) => {
        result.reasoning += t
        o.onReasoning?.(t)
      }
    )
    for await (const line of lines(res)) {
      let j: {
        message?: { content?: string; thinking?: string; tool_calls?: { id?: string; function: { name: string; arguments: unknown } }[] }
        error?: string
      }
      try {
        j = JSON.parse(line)
      } catch {
        continue
      }
      if (j.error) throw new ModelError('http', j.error)
      const m = j.message
      if (!m) continue
      if (m.thinking) {
        result.reasoning += m.thinking
        o.onReasoning?.(m.thinking)
      }
      if (m.content) split.push(m.content)
      for (const tc of m.tool_calls ?? []) {
        result.toolCalls.push({
          id: tc.id ?? `call_${result.toolCalls.length + 1}`,
          name: tc.function.name,
          args: parseArgs(tc.function.arguments)
        })
      }
    }
    split.flush()
    return result
  }

  async embed(model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await request(this.base + '/api/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts, keep_alive: OLLAMA_KEEP_ALIVE }),
      signal
    })
    const j = (await res.json()) as { embeddings?: number[][] }
    if (!j.embeddings) throw new ModelError('http', 'Risposta di embedding non valida')
    return j.embeddings
  }
}

/* ------------------------------------------------ OpenAI-compatible (LM Studio, …) */

export interface OpenAICompatOptions {
  headers?: Record<string, string>
  /** Extra fields for the chat request, e.g. llama-server's chat_template_kwargs. */
  extraBody?: (o: ChatOptions) => Record<string, unknown>
}

export class OpenAICompatClient implements ChatClient {
  constructor(
    private base: string,
    private opts: OpenAICompatOptions = {}
  ) {}

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await request(this.base + '/models', { signal, headers: this.opts.headers })
    const j = (await res.json()) as { data?: { id: string }[] }
    return (j.data ?? []).map((m) => m.id).sort()
  }

  async chat(o: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: o.model,
      stream: true,
      temperature: o.temperature,
      messages: o.messages.map((m) => {
        if (m.role === 'assistant')
          return {
            role: 'assistant',
            content: m.content || null,
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.args) }
                  }))
                }
              : {})
          }
        if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
        if (m.images?.length)
          return {
            role: m.role,
            content: [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
          }
        return { role: m.role, content: m.content }
      }),
      ...this.opts.extraBody?.(o)
    }
    if (o.tools?.length) body.tools = o.tools.map((t) => ({ type: 'function', function: t }))
    const res = await request(this.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.opts.headers },
      body: JSON.stringify(body),
      signal: o.signal
    })
    const result: ChatResult = { content: '', reasoning: '', toolCalls: [] }
    const partial: { id: string; name: string; args: string }[] = []
    const split = new ThinkSplitter(
      (t) => {
        result.content += t
        o.onText?.(t)
      },
      (t) => {
        result.reasoning += t
        o.onReasoning?.(t)
      }
    )
    for await (const line of lines(res)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') break
      let j: {
        choices?: {
          delta?: {
            content?: string | null
            reasoning_content?: string
            reasoning?: string
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
          }
        }[]
        error?: { message?: string }
      }
      try {
        j = JSON.parse(data)
      } catch {
        continue
      }
      if (j.error) throw new ModelError('http', j.error.message ?? 'Errore del modello')
      const d = j.choices?.[0]?.delta
      if (!d) continue
      const r = d.reasoning_content ?? d.reasoning
      if (r) {
        result.reasoning += r
        o.onReasoning?.(r)
      }
      if (d.content) split.push(d.content)
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? partial.length
        partial[i] ??= { id: tc.id ?? `call_${i + 1}`, name: '', args: '' }
        if (tc.id) partial[i].id = tc.id
        if (tc.function?.name) partial[i].name += tc.function.name
        if (tc.function?.arguments) partial[i].args += tc.function.arguments
      }
    }
    split.flush()
    result.toolCalls = partial.filter(Boolean).map((p) => ({ id: p.id, name: p.name, args: parseArgs(p.args) }))
    return result
  }

  async embed(model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await request(this.base + '/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.opts.headers },
      body: JSON.stringify({ model, input: texts }),
      signal
    })
    const j = (await res.json()) as { data?: { embedding: number[]; index: number }[] }
    if (!j.data) throw new ModelError('http', 'Risposta di embedding non valida')
    return [...j.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Some models write tool calls as text (<tool_call>{…}</tool_call>) instead of using the API field. */
export function extractInlineToolCalls(content: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = []
  const rest = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, json: string) => {
    try {
      const j = JSON.parse(json) as { name?: string; arguments?: unknown }
      if (j.name) calls.push({ id: `inline_${calls.length + 1}`, name: j.name, args: parseArgs(j.arguments) })
    } catch {
      return _m
    }
    return ''
  })
  return { calls, rest: rest.trim() }
}
