import type { AgentEvent, AgentToolCall, AiSettings } from '@shared/types'
import type { VaultKnowledge } from './knowledge'
import { createClient, extractInlineToolCalls, ModelError, type ChatMessage, type ChatResult, type ToolCall } from './llm'
import { buildSystemPrompt } from './prompt'
import { TOOLS, toolSpecs, type ToolContext, type ToolResult } from './tools'

const MAX_STEPS = 12

export interface AgentHost {
  emit(e: AgentEvent): void
  settings(): AiSettings
  /** Tool context for the open vault (everything but approval), or null when no vault is open. */
  context(): Omit<ToolContext, 'approve'> | null
  rules(): Promise<string>
  readOnly?: boolean
}

/** One conversation with the local model, with tool use, approvals for writes and streaming events. */
export class AgentSession {
  private history: ChatMessage[] = []
  private abort: AbortController | null = null
  private approvals = new Map<string, (ok: boolean) => void>()
  private runs = 0
  running = false

  constructor(private host: AgentHost) {}

  reset(): void {
    this.stop()
    this.history = []
  }

  stop(): void {
    this.abort?.abort()
    for (const resolve of this.approvals.values()) resolve(false)
    this.approvals.clear()
  }

  approve(callId: string, ok: boolean): void {
    this.approvals.get(callId)?.(ok)
  }

  async send(text: string): Promise<void> {
    if (this.running) return
    const emit = this.host.emit
    const s = this.host.settings()
    const base = this.host.context()
    emit({ type: 'start' })
    if (!base) return emit({ type: 'error', message: 'Apri prima un vault.' })
    if (!s.model) return emit({ type: 'error', message: "Scegli un modello nelle impostazioni dell'agente." })

    this.running = true
    this.abort = new AbortController()
    const signal = this.abort.signal
    const run = ++this.runs
    const client = createClient(s, base.dataDir)
    const readOnly = !!this.host.readOnly
    if (!this.history.length) {
      this.history.push({ role: 'system', content: buildSystemPrompt(base.knowledge(), await this.host.rules(), readOnly) })
    }
    this.history.push({ role: 'user', content: text })

    let useTools = true
    let think = s.think
    const vision = (await client.canSee?.(s.model).catch(() => false)) ?? false
    const seen = new Set<string>()
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        let res: ChatResult
        // one status per phase change, not per streamed token
        let phase: 'reasoning' | 'writing' | null = null
        const enter = (p: 'reasoning' | 'writing'): void => {
          if (phase === p) return
          phase = p
          emit({ type: 'status', phase: p, text: p === 'reasoning' ? 'Sto ragionando' : 'Scrivo la risposta' })
        }
        emit({ type: 'status', phase: 'thinking', text: step === 0 ? 'Elaboro la richiesta' : 'Valuto i risultati' })
        try {
          res = await client.chat({
            model: s.model,
            messages: this.history,
            tools: useTools ? toolSpecs(readOnly, vision) : undefined,
            temperature: s.temperature,
            numCtx: s.numCtx,
            think,
            signal,
            onText: (delta) => {
              enter('writing')
              emit({ type: 'text', delta })
            },
            onReasoning: (delta) => {
              enter('reasoning')
              emit({ type: 'reasoning', delta })
            }
          })
        } catch (err) {
          if (err instanceof ModelError && err.code === 'no-think' && think) {
            think = false
            emit({ type: 'notice', message: 'Questo modello non supporta il ragionamento esteso: lo disattivo.' })
            step--
            continue
          }
          if (err instanceof ModelError && err.code === 'no-tools' && useTools) {
            useTools = false
            emit({
              type: 'notice',
              message: 'Il modello scelto non supporta gli strumenti: cerco io le note pertinenti e gliele passo, ma non potrà modificare il vault.'
            })
            this.injectContext(base.knowledge(), text, `${run}-ctx`)
            step--
            continue
          }
          throw err
        }

        let calls: ToolCall[] = res.toolCalls
        let content = res.content
        if (!calls.length && useTools) {
          const inline = extractInlineToolCalls(content)
          if (inline.calls.length) {
            calls = inline.calls
            content = inline.rest
          }
        }
        this.history.push({ role: 'assistant', content, toolCalls: calls.length ? calls : undefined })
        if (!calls.length) break
        for (const [i, call] of calls.entries()) {
          if (signal.aborted) break
          // small models can get stuck repeating the very same call: answer it without running it again
          const key = `${call.name}\u0000${JSON.stringify(call.args)}`
          if (seen.has(key)) {
            this.history.push({
              role: 'tool',
              content: 'Hai già fatto questa stessa chiamata e il risultato non cambia. Usa i risultati che hai, prova un altro strumento o rispondi.',
              toolCallId: call.id,
              toolName: call.name
            })
            continue
          }
          seen.add(key)
          const result = await this.runTool(call, `${run}-${step}-${i}`, base, s, signal)
          this.history.push({ role: 'tool', content: result.content, toolCallId: call.id, toolName: call.name })
          // tool messages cannot carry pictures: they follow as a user message
          if (result.images?.length) this.history.push({ role: 'user', content: `Immagine richiesta con ${call.name}:`, images: result.images })
        }
        if (step === MAX_STEPS - 1) emit({ type: 'notice', message: 'Raggiunto il numero massimo di passi per questa risposta.' })
      }
      emit({ type: 'done' })
    } catch (err) {
      if (signal.aborted) emit({ type: 'done' })
      else emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      this.repairHistory()
      this.dropImages()
      this.running = false
      this.abort = null
    }
  }

  /** Pictures are heavy: once a reply is done they leave the history, and the model sees a note instead. */
  private dropImages(): void {
    for (const m of this.history) {
      if (!m.images?.length) continue
      delete m.images
      m.content += ' (immagine già esaminata, non più allegata: se serve, guardala di nuovo con view_image)'
    }
  }

  /** After a stop or an error, make sure every tool call has a result so the next request stays valid. */
  private repairHistory(): void {
    const last = [...this.history].reverse().find((m) => m.role === 'assistant')
    if (!last?.toolCalls?.length) return
    const answered = new Set(this.history.filter((m) => m.role === 'tool').map((m) => m.toolCallId))
    for (const c of last.toolCalls) {
      if (!answered.has(c.id)) this.history.push({ role: 'tool', content: 'Interrotto dall’utente.', toolCallId: c.id, toolName: c.name })
    }
  }

  private async runTool(
    call: ToolCall,
    uiId: string,
    base: Omit<ToolContext, 'approve'>,
    s: AiSettings,
    signal: AbortSignal
  ): Promise<ToolResult> {
    const emit = this.host.emit
    const def = TOOLS.find((t) => t.name === call.name)
    const ui: AgentToolCall = { id: uiId, name: call.name, label: def ? def.label(call.args) : call.name, args: call.args, status: 'running' }
    emit({ type: 'tool', call: { ...ui } })
    emit({ type: 'status', phase: 'tool', text: def ? def.activity(call.args) : `Uso ${call.name}` })

    const fail = (message: string): ToolResult => {
      ui.status = 'error'
      ui.summary = message
      emit({ type: 'tool', call: { ...ui } })
      return { content: `Errore: ${message}`, summary: message, ids: [] }
    }
    if (!def) return fail(`strumento sconosciuto "${call.name}". Disponibili: ${TOOLS.map((t) => t.name).join(', ')}`)
    if (def.write && this.host.readOnly) return fail('il vault è in sola lettura')

    const ctx: ToolContext = {
      ...base,
      approve: async (req) => {
        ui.preview = { path: req.id, isNew: req.isNew, diff: req.diff }
        if (s.autoApprove) {
          emit({ type: 'tool', call: { ...ui } })
          return true
        }
        ui.status = 'awaiting'
        emit({ type: 'tool', call: { ...ui } })
        emit({ type: 'status', phase: 'awaiting', text: 'Aspetto la tua approvazione' })
        emit({ type: 'activity', ids: [req.id], mode: 'write' })
        const ok = await new Promise<boolean>((resolve) => {
          this.approvals.set(uiId, resolve)
          signal.addEventListener('abort', () => resolve(false), { once: true })
        })
        this.approvals.delete(uiId)
        ui.status = ok ? 'running' : 'rejected'
        emit({ type: 'tool', call: { ...ui } })
        if (ok) emit({ type: 'status', phase: 'tool', text: 'Salvo la modifica' })
        return ok
      }
    }
    try {
      const r = await def.run(call.args, ctx)
      ui.status = r.rejected ? 'rejected' : 'done'
      ui.summary = r.summary
      ui.ids = r.ids
      if (r.change) ui.change = { changeId: r.change.changeId }
      emit({ type: 'tool', call: { ...ui } })
      if (r.ids.length) emit({ type: 'activity', ids: r.ids, mode: def.write ? 'write' : 'read' })
      return r
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }

  /** Fallback for models without tool support: retrieve the most relevant notes and put them in the prompt. */
  private injectContext(k: VaultKnowledge, question: string, uiId: string): void {
    const hits = k.search(question, { limit: 6 })
    const ui: AgentToolCall = {
      id: uiId,
      name: 'search_notes',
      label: `Cerca «${question.slice(0, 60)}»`,
      args: { query: question },
      status: 'done',
      summary: `${hits.length} note`,
      ids: hits.map((h) => h.id)
    }
    this.host.emit({ type: 'tool', call: ui })
    if (hits.length) this.host.emit({ type: 'activity', ids: ui.ids!, mode: 'read' })
    const context = hits
      .map((h) => `### [[${h.title}]]${h.corso ? ` (${h.corso})` : ''}\n${(k.notes.get(h.id)?.body ?? '').slice(0, 1800)}`)
      .join('\n\n')
    const last = this.history[this.history.length - 1]
    last.content = `${question}\n\n---\nNote del vault che potrebbero essere pertinenti:\n\n${context || '(nessuna)'}`
  }
}
