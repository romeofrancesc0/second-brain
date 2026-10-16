/**
 * Always-on Second Brain service (no UI): the same agent as the app, reachable from a Telegram bot.
 *
 *   node out/main/server.js [--data-dir <dir>]
 *
 * Reads <data-dir>/server.json:
 *   { "vault": "C:\\Users\\me\\SECONDBRAIN", "telegramToken": "123:ABC", "allowedUsers": [123456789] }
 * and the model settings ("ai") from <data-dir>/config.json, the file the desktop app writes.
 * Telegram is polled (outgoing connections only): no port has to be opened on the router.
 */
import { promises as fs, watch } from 'node:fs'
import { basename, join } from 'node:path'
import { DEFAULT_AI, type AgentEvent, type AgentToolCall, type AiSettings } from '@shared/types'
import { AgentSession } from '../main/agent/agent'
import { EmbeddingIndex } from '../main/agent/embeddings'
import { VaultKnowledge } from '../main/agent/knowledge'
import { createClient } from '../main/agent/llm'
import { readVaultRules } from '../main/agent/prompt'
import { undoChange, type ToolContext } from '../main/agent/tools'
import { secondBrainDataDir } from '../main/platform'
import { scanVault } from '../main/vault'

interface ServerConfig {
  vault: string
  telegramToken?: string
  allowedUsers?: number[]
}

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a)

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function main(): Promise<void> {
  const dataDir = arg('--data-dir') ?? secondBrainDataDir()
  const cfg = await readJson<ServerConfig | null>(join(dataDir, 'server.json'), null)
  if (!cfg?.vault) {
    console.error(`Manca ${join(dataDir, 'server.json')} con almeno { "vault": "<percorso del vault>" }`)
    process.exit(2)
  }
  const vault = cfg.vault
  const aiSettings = async (): Promise<AiSettings> => ({ ...DEFAULT_AI, ...(await readJson<{ ai?: Partial<AiSettings> }>(join(dataDir, 'config.json'), {})).ai })
  let ai = await aiSettings()

  // ------------------------------------------------------------- vault knowledge
  let index = ai.embedModel ? await EmbeddingIndex.load(dataDir, vault, ai.embedModel) : null
  let knowledge = new VaultKnowledge(vault, await scanVault(vault))
  knowledge.embeddings = index
  const rescan = async (): Promise<void> => {
    knowledge = new VaultKnowledge(vault, await scanVault(vault))
    knowledge.embeddings = index
  }
  let timer: NodeJS.Timeout | null = null
  watch(vault, { recursive: true }, (_e, f) => {
    if (!f || String(f).split(/[\\/]/).some((p) => p.startsWith('.'))) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void rescan().catch((err) => log('rescan', err)), 1000)
  })
  log(`vault ${vault}: ${knowledge.notes.size} note · modello ${ai.model || '(non impostato)'} @ ${ai.baseUrl}`)

  const context = (): Ctx => ({
    vaultPath: vault,
    dataDir,
    knowledge: () => knowledge,
    refresh: rescan,
    embedQuery: async (text: string) => {
      if (!index || !ai.embedModel) return null
      try {
        const [v] = await createClient(ai).embed(ai.embedModel, [text])
        return Float32Array.from(v)
      } catch {
        return null
      }
    }
  })

  if (!cfg.telegramToken) {
    log('nessun telegramToken in server.json: servizio avviato senza bot')
    return
  }
  await runTelegram(cfg, dataDir, vault, context, async () => {
    ai = await aiSettings()
    if (ai.embedModel && !index) index = await EmbeddingIndex.load(dataDir, vault, ai.embedModel)
    return ai
  })
}

/* ------------------------------------------------------------------ Telegram */

type Ctx = Omit<ToolContext, 'approve'>

async function runTelegram(
  cfg: ServerConfig,
  dataDir: string,
  vault: string,
  context: () => Ctx,
  settings: () => Promise<AiSettings>
): Promise<void> {
  const api = async <T>(method: string, body: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const j = (await res.json()) as { ok: boolean; result: T; description?: string }
    if (!j.ok) throw new Error(`${method}: ${j.description}`)
    return j.result
  }
  const allowed = new Set(cfg.allowedUsers ?? [])
  const me = await api<{ username: string }>('getMe')
  log(`bot Telegram @${me.username} attivo · utenti autorizzati: ${[...allowed].join(', ') || 'nessuno'}`)

  const send = (chat: number, text: string, extra: Record<string, unknown> = {}): Promise<{ message_id: number }> =>
    api('sendMessage', { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra })

  interface Chat {
    session: AgentSession
    answer: string
    tools: Map<string, AgentToolCall>
    typing?: NodeJS.Timeout
  }
  const chats = new Map<number, Chat>()
  let current: AiSettings = await settings()

  const chatFor = (id: number): Chat => {
    let c = chats.get(id)
    if (c) return c
    const state: Chat = { answer: '', tools: new Map(), session: null as unknown as AgentSession }
    state.session = new AgentSession({
      settings: () => current,
      rules: () => readVaultRules(vault),
      context,
      emit: (e) => void onEvent(id, state, e).catch((err) => log('telegram', err))
    })
    chats.set(id, state)
    return state
  }

  // [[Titolo]] is meaningless in Telegram: show it as «Titolo»
  const plain = (s: string): string => s.replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, '«$1»')

  async function onEvent(chat: number, c: Chat, e: AgentEvent): Promise<void> {
    if (e.type === 'text') c.answer += e.delta
    if (e.type === 'notice') await send(chat, 'ℹ️ ' + e.message)
    if (e.type === 'tool') {
      c.tools.set(e.call.id, e.call)
      if (e.call.status === 'awaiting' && e.call.preview) {
        const p = e.call.preview
        const diff = p.diff
          .filter((d) => d.op !== ' ' || d.text === '…')
          .map((d) => `${d.op} ${d.text}`)
          .join('\n')
          .slice(0, 2500)
        await send(chat, `✏️ ${e.call.label}\n${p.isNew ? 'Nuova nota' : 'Modifica'}: ${p.path}\n\n${diff}`, {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approva', callback_data: `ap:${e.call.id}` },
              { text: '✖️ Rifiuta', callback_data: `rj:${e.call.id}` }
            ]]
          }
        })
      }
    }
    if (e.type === 'error') await send(chat, '⚠️ ' + e.message)
    if (e.type === 'done' || e.type === 'error') {
      clearInterval(c.typing)
      const used = [...c.tools.values()].filter((t) => t.status === 'done')
      const changes = used.filter((t) => t.change)
      const footer = used.length ? `\n\n— ${used.map((t) => t.label).join(' · ')}`.slice(0, 600) : ''
      if (c.answer.trim()) {
        const text = plain(c.answer.trim()) + footer
        for (let i = 0; i < text.length; i += 3900) await send(chat, text.slice(i, i + 3900))
      }
      for (const t of changes)
        await send(chat, `Modifica applicata: ${t.preview?.path ?? ''}`, {
          reply_markup: { inline_keyboard: [[{ text: '↩️ Annulla modifica', callback_data: `un:${t.change!.changeId}` }]] }
        })
      c.answer = ''
      c.tools.clear()
    }
  }

  async function onMessage(m: { chat: { id: number }; from?: { id: number; first_name?: string }; text?: string }): Promise<void> {
    const chat = m.chat.id
    const user = m.from?.id ?? 0
    if (!allowed.has(user)) {
      await send(chat, `Questo bot è privato. Il tuo ID Telegram è ${user}: per autorizzarti aggiungilo ad "allowedUsers" in server.json sul computer di casa e riavvia il servizio.`)
      log(`messaggio rifiutato da ${user} (${m.from?.first_name ?? ''})`)
      return
    }
    const text = (m.text ?? '').trim()
    if (!text) return
    const c = chatFor(chat)
    if (text === '/start' || text === '/aiuto') {
      return void send(chat, `Ciao! Fammi domande sul tuo second brain (${basename(vault)}).\n/nuova — nuova conversazione\n/stop — interrompi\n/modello — modello in uso`)
    }
    if (text === '/nuova') {
      c.session.reset()
      return void send(chat, 'Nuova conversazione.')
    }
    if (text === '/stop') {
      c.session.stop()
      return void send(chat, 'Interrotto.')
    }
    if (text === '/modello') return void send(chat, `${current.model || '(nessuno)'} @ ${current.baseUrl}`)
    if (c.session.running) return void send(chat, 'Sto ancora lavorando alla domanda precedente (/stop per interrompere).')
    current = await settings()
    c.answer = ''
    c.tools.clear()
    void api('sendChatAction', { chat_id: chat, action: 'typing' })
    c.typing = setInterval(() => void api('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {}), 4500)
    void c.session.send(text)
  }

  async function onCallback(q: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number }; message_id: number } }): Promise<void> {
    if (!allowed.has(q.from.id) || !q.message) return
    const chat = q.message.chat.id
    const [kind, id] = (q.data ?? '').split(':')
    let note = ''
    if (kind === 'ap' || kind === 'rj') {
      chatFor(chat).session.approve(id, kind === 'ap')
      note = kind === 'ap' ? '✅ Approvata' : '✖️ Rifiutata'
    }
    if (kind === 'un') {
      const trash = async (abs: string): Promise<void> => {
        const dir = join(dataDir, 'agent-changes', 'trash')
        await fs.mkdir(dir, { recursive: true })
        await fs.rename(abs, join(dir, Date.now() + '-' + basename(abs)))
      }
      const r = await undoChange(dataDir, vault, id, trash)
      note = r.ok ? '↩️ ' + r.message : '⚠️ ' + r.message
    }
    await api('answerCallbackQuery', { callback_query_id: q.id, text: note.slice(0, 190) })
    await api('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {})
    if (note) await send(chat, note)
  }

  let offset = 0
  for (;;) {
    try {
      const updates = await api<{ update_id: number; message?: Parameters<typeof onMessage>[0]; callback_query?: Parameters<typeof onCallback>[0] }[]>(
        'getUpdates',
        { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }
      )
      for (const u of updates) {
        offset = u.update_id + 1
        if (u.message) void onMessage(u.message).catch((err) => log('message', err))
        if (u.callback_query) void onCallback(u.callback_query).catch((err) => log('callback', err))
      }
    } catch (err) {
      log('polling', (err as Error).message)
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
