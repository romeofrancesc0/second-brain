import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { Document, parseDocument, type YAMLSeq } from 'yaml'
import type { DiffLine } from '@shared/types'
import { safeVaultPath } from '../vault'
import { normalize, type VaultKnowledge } from './knowledge'
import type { ToolSpec } from './llm'

/* ------------------------------------------------------------------- types */

export interface WriteRequest {
  tool: string
  id: string
  isNew: boolean
  before: string
  after: string
  diff: DiffLine[]
}

export interface AppliedChange {
  changeId: string
  id: string
  kind: 'create' | 'update'
  tool: string
  time: number
  backup?: string
}

export interface ToolContext {
  vaultPath: string
  /** Where backups and the change journal live. */
  dataDir: string
  knowledge(): VaultKnowledge
  /** Embeds a search query when a semantic index is available. */
  embedQuery?(text: string): Promise<Float32Array | null>
  /** Asks the user (or an auto-approve policy) whether a write may happen. */
  approve(req: WriteRequest): Promise<boolean>
  /** Re-reads the vault after a write so later tool calls see the change. */
  refresh(): Promise<void>
}

export interface ToolResult {
  /** What the model reads. */
  content: string
  /** Short Italian summary for the UI. */
  summary: string
  ids: string[]
  change?: AppliedChange
  rejected?: boolean
}

export interface ToolDef extends ToolSpec {
  write?: boolean
  label(args: Record<string, unknown>): string
  /** What the agent is doing while the tool runs, e.g. "Cerco «trasformata z» in Segnali". */
  activity(args: Record<string, unknown>): string
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/* ----------------------------------------------------------------- helpers */

const PROTECTED_FOLDERS = ['fonti'] // raw sources: never modified (vault rule)
const MAX_NOTE_CHARS = 7000

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim()
/** " in <course or area>" when the arguments restrict the tool to one region of the vault. */
const where = (a: Record<string, unknown>): string => (str(a.corso) ? ` in ${str(a.corso)}` : str(a.area) ? ` in ${str(a.area)}` : '')
const num = (v: unknown, def: number): number => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : def)
const strList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/^\s*\[|\]\s*$/g, '').split(',') : [])
    .map((t) => String(t).replace(/^[\s"'#]+|[\s"']+$/g, '').toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean)

function link(k: VaultKnowledge, id: string): string {
  const title = k.title(id)
  const same = [...k.nodes.values()].filter((n) => (n.kind === 'note' || n.kind === 'moc') && n.title === title).length
  return `[[${same > 1 ? id.replace(/\.md$/, '') : title}]]`
}

function noteOrError(k: VaultKnowledge, ref: unknown): { id: string } | ToolResult {
  const r = k.resolveNote(str(ref))
  if ('id' in r) return r
  return {
    content: `${r.error}.${r.suggestions.length ? ' Forse intendevi: ' + r.suggestions.map((t) => `[[${t}]]`).join(', ') : ''}`,
    summary: 'Nota non trovata',
    ids: []
  }
}

function assertWritable(id: string): void {
  const parts = id.split('/')
  if (!id.toLowerCase().endsWith('.md')) throw new Error('Si possono modificare solo note Markdown (.md)')
  if (parts.some((p) => p.startsWith('.'))) throw new Error('Cartella non modificabile')
  if (PROTECTED_FOLDERS.includes(parts[0].toLowerCase())) throw new Error(`La cartella ${parts[0]}/ contiene le fonti originali e non va modificata`)
}

function splitRaw(src: string): { fm: string | null; body: string } {
  const text = src.replace(/^﻿/, '')
  if (!text.startsWith('---')) return { fm: null, body: text }
  const end = text.search(/\n---[ \t]*(\r?\n|$)/)
  if (end === -1) return { fm: null, body: text }
  return { fm: text.slice(3, end).replace(/^\r?\n/, ''), body: text.slice(end).replace(/^\n---[ \t]*\r?\n?/, '') }
}

function compose(fm: string | null, body: string): string {
  const b = body.replace(/^\s*\n/, '').replace(/\s*$/, '\n')
  return fm !== null ? `---\n${fm.trimEnd()}\n---\n\n${b}` : b
}

function withTags(fm: string | null, tags: string[]): string {
  const doc: Document = fm && fm.trim() ? parseDocument(fm) : new Document({})
  const node = doc.createNode(tags) as YAMLSeq
  node.flow = true
  doc.set('tags', node)
  return doc.toString({ flowCollectionPadding: false })
}

function cleanTitle(t: string): string {
  return t
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/** Line diff (LCS) compressed to the changed hunks with a little context. */
export function lineDiff(a: string, b: string, context = 2): DiffLine[] {
  const x = a ? a.split('\n') : []
  const y = b.split('\n')
  if (x.length * y.length > 250_000) return [...x.map((t) => ({ op: '-' as const, text: t })), ...y.map((t) => ({ op: '+' as const, text: t }))]
  const n = x.length
  const m = y.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ op: ' ', text: x[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ op: '-', text: x[i++] })
    else ops.push({ op: '+', text: y[j++] })
  }
  while (i < n) ops.push({ op: '-', text: x[i++] })
  while (j < m) ops.push({ op: '+', text: y[j++] })
  // keep only changed lines and their context
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((o, k) => {
    if (o.op !== ' ') for (let d = -context; d <= context; d++) if (ops[k + d]) keep[k + d] = true
  })
  const out: DiffLine[] = []
  ops.forEach((o, k) => {
    if (keep[k]) out.push(o)
    else if (out.length && out[out.length - 1].text !== '…') out.push({ op: ' ', text: '…' })
  })
  return out
}

const journalPath = (dataDir: string): string => join(dataDir, 'agent-changes', 'journal.jsonl')

async function applyWrite(ctx: ToolContext, tool: string, id: string, after: string, isNew: boolean): Promise<ToolResult> {
  assertWritable(id)
  const abs = safeVaultPath(ctx.vaultPath, id)
  const before = isNew ? '' : await fs.readFile(abs, 'utf8')
  if (!isNew && before === after) return { content: 'Nessuna modifica necessaria: il contenuto è già quello richiesto.', summary: 'Nessuna modifica', ids: [id] }
  const ok = await ctx.approve({ tool, id, isNew, before, after, diff: lineDiff(before, after) })
  if (!ok)
    return {
      content: "L'utente ha rifiutato questa modifica. Non riproporla uguale: chiedi all'utente come preferisce procedere.",
      summary: 'Modifica rifiutata',
      ids: [id],
      rejected: true
    }
  const changeId = randomUUID()
  const dir = join(ctx.dataDir, 'agent-changes')
  await fs.mkdir(join(dir, 'backups'), { recursive: true })
  let backup: string | undefined
  if (!isNew) {
    backup = join(dir, 'backups', changeId + '.md')
    await fs.writeFile(backup, before)
  }
  await fs.mkdir(dirname(abs), { recursive: true })
  await fs.writeFile(abs, after)
  const change: AppliedChange = { changeId, id, kind: isNew ? 'create' : 'update', tool, time: Date.now(), backup }
  await fs.appendFile(journalPath(ctx.dataDir), JSON.stringify(change) + '\n')
  await ctx.refresh()
  return {
    content: isNew ? `Nota creata: ${id}` : `Nota aggiornata: ${id}`,
    summary: isNew ? 'Nota creata' : 'Nota aggiornata',
    ids: [id],
    change
  }
}

/** Reverts a change made by the agent: restores the backup, or moves a created note to the trash. */
export async function undoChange(
  dataDir: string,
  vaultPath: string,
  changeId: string,
  trash: (abs: string) => Promise<void>
): Promise<{ ok: boolean; message: string }> {
  const entries = (await fs.readFile(journalPath(dataDir), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AppliedChange & { undo?: string })
  const undone = new Set(entries.filter((e) => e.undo).map((e) => e.undo))
  const changes = entries.filter((e) => !e.undo)
  const change = changes.find((c) => c.changeId === changeId)
  if (!change) return { ok: false, message: 'Modifica non trovata nel registro' }
  if (undone.has(changeId)) return { ok: false, message: 'Modifica già annullata' }
  // restoring an older backup would silently drop the later edits to the same note
  if (changes.some((c) => c.id === change.id && c.time > change.time && !undone.has(c.changeId)))
    return { ok: false, message: 'Questa nota è stata modificata di nuovo dopo: annulla prima le modifiche più recenti.' }
  const abs = safeVaultPath(vaultPath, change.id)
  if (change.kind === 'create') {
    if (existsSync(abs)) await trash(abs)
  } else {
    if (!change.backup) return { ok: false, message: 'Backup mancante' }
    // keep the current text too, so the undo itself can be reverted by hand
    if (existsSync(abs)) await fs.copyFile(abs, change.backup.replace(/\.md$/, '.before-undo.md'))
    await fs.writeFile(abs, await fs.readFile(change.backup, 'utf8'))
  }
  await fs.appendFile(journalPath(dataDir), JSON.stringify({ undo: changeId, time: Date.now() }) + '\n')
  return {
    ok: true,
    message: change.kind === 'create' ? `Nota spostata nel Cestino: ${change.id}` : `Ripristinata la versione precedente di ${change.id}`
  }
}

/* ------------------------------------------------------------------- tools */

const noteParam = { type: 'string', description: 'Note title (e.g. "Trasformata Z") or vault path' }

export const TOOLS: ToolDef[] = [
  {
    name: 'list_courses',
    description:
      'List the regions of the vault (courses / areas) with the number of notes and the MOC (map of content) note of each. Use it to orient yourself in the vault.',
    parameters: { type: 'object', properties: {} },
    label: () => 'Panoramica dei corsi',
    activity: () => 'Esploro le regioni del vault',
    async run(_a, ctx) {
      const k = ctx.knowledge()
      const rows = k.courses()
      return {
        content: rows.map((r) => `- ${r.corso}: ${r.notes} note${r.moc ? ` (MOC: [[${r.moc}]])` : ''}`).join('\n'),
        summary: `${rows.length} regioni`,
        ids: []
      }
    }
  },
  {
    name: 'search_notes',
    description:
      'Search the notes of the vault by keywords (and by meaning when the semantic index is on). Returns titles, course, tags and a snippet. Always search before answering a question about the vault.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        corso: { type: 'string', description: 'Optional: restrict to one course' },
        area: { type: 'string', description: 'Optional: restrict to one area' },
        tag: { type: 'string', description: 'Optional: restrict to notes with this tag' },
        limit: { type: 'integer', description: 'Max results (default 8)' }
      },
      required: ['query']
    },
    label: (a) => `Cerca «${str(a.query)}»`,
    activity: (a) => `Cerco «${str(a.query)}»${where(a)}`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const query = str(a.query)
      const queryVector = ctx.embedQuery ? await ctx.embedQuery(query) : null
      const filters = { corso: str(a.corso) || undefined, area: str(a.area) || undefined, tag: str(a.tag) || undefined }
      let hits = k.search(query, { ...filters, limit: num(a.limit, 8), queryVector })
      // small models often invent a course or area name: fall back to the whole vault
      let note = ''
      if (!hits.length && (filters.corso || filters.area || filters.tag)) {
        hits = k.search(query, { limit: num(a.limit, 8), queryVector })
        if (hits.length) note = 'Nessun risultato con i filtri indicati (corso/area/tag non trovati): ecco i risultati in tutto il vault.\n'
      }
      if (!hits.length) return { content: 'Nessuna nota trovata. Prova con parole diverse o più generiche.', summary: 'Nessun risultato', ids: [] }
      return {
        content:
          note +
          hits
          .map((h, i) => `${i + 1}. ${link(k, h.id)}${h.corso ? ` (${h.corso})` : ''}${h.tags.length ? ` #${h.tags.slice(0, 5).join(' #')}` : ''}\n   ${h.snippet}`)
          .join('\n'),
        summary: `${hits.length} risultati`,
        ids: hits.map((h) => h.id)
      }
    }
  },
  {
    name: 'read_note',
    description: 'Read the full content of a note, with its metadata, outgoing links and backlinks.',
    parameters: { type: 'object', properties: { note: noteParam }, required: ['note'] },
    label: (a) => `Legge «${str(a.note)}»`,
    activity: (a) => `Leggo «${str(a.note)}»`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const r = noteOrError(k, a.note)
      if (!('id' in r)) return r
      const note = k.notes.get(r.id)!
      const node = k.nodes.get(r.id)!
      const out = [...(k.out.get(r.id) ?? [])].filter((x) => k.isNote(x))
      const back = [...(k.in.get(r.id) ?? [])].filter((x) => k.isNote(x))
      const body = note.body.length > MAX_NOTE_CHARS ? note.body.slice(0, MAX_NOTE_CHARS) + '\n…(troncata)' : note.body
      return {
        content: [
          `Titolo: ${node.title}`,
          `Percorso: ${r.id}`,
          node.area ? `Area: ${node.area}` : '',
          node.corso ? `Corso: ${node.corso}` : '',
          node.tags.length ? `Tag: ${node.tags.join(', ')}` : '',
          '',
          body.trim(),
          '',
          `Link in uscita: ${out.map((x) => link(k, x)).join(', ') || 'nessuno'}`,
          `Backlink: ${back.map((x) => link(k, x)).join(', ') || 'nessuno'}`
        ]
          .filter((l, i) => l !== '' || i > 4)
          .join('\n'),
        summary: `${node.words} parole`,
        ids: [r.id]
      }
    }
  },
  {
    name: 'list_neighbors',
    description: 'List the notes directly connected to a note: the ones it links to and the ones linking to it.',
    parameters: { type: 'object', properties: { note: noteParam }, required: ['note'] },
    label: (a) => `Collegamenti di «${str(a.note)}»`,
    activity: (a) => `Seguo i collegamenti di «${str(a.note)}»`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const r = noteOrError(k, a.note)
      if (!('id' in r)) return r
      const out = [...(k.out.get(r.id) ?? [])].filter((x) => k.isNote(x))
      const back = [...(k.in.get(r.id) ?? [])].filter((x) => k.isNote(x))
      const fmt = (ids: string[]): string => ids.map((x) => `${link(k, x)}${k.nodes.get(x)?.corso ? ` (${k.nodes.get(x)!.corso})` : ''}`).join('\n') || 'nessuno'
      return {
        content: `Link in uscita da ${link(k, r.id)}:\n${fmt(out)}\n\nBacklink verso ${link(k, r.id)}:\n${fmt(back)}`,
        summary: `${out.length + back.length} collegamenti`,
        ids: [r.id, ...out, ...back]
      }
    }
  },
  {
    name: 'list_notes',
    description: 'List note titles filtered by course, area or tag (useful to get an overview of a topic).',
    parameters: {
      type: 'object',
      properties: {
        corso: { type: 'string' },
        area: { type: 'string' },
        tag: { type: 'string' },
        limit: { type: 'integer', description: 'Max titles (default 80)' }
      }
    },
    label: (a) => `Elenca le note${str(a.corso) ? ` di ${str(a.corso)}` : str(a.tag) ? ` con #${str(a.tag)}` : ''}`,
    activity: (a) => `Sfoglio le note${str(a.tag) ? ` con #${str(a.tag)}` : ''}${where(a)}`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const corso = normalize(str(a.corso))
      const area = normalize(str(a.area))
      const tag = normalize(str(a.tag).replace(/^#/, ''))
      const list = [...k.nodes.values()].filter(
        (n) =>
          (n.kind === 'note' || n.kind === 'moc') &&
          (!corso || normalize(n.corso ?? '').includes(corso)) &&
          (!area || normalize(n.area ?? '') === area) &&
          (!tag || n.tags.some((t) => normalize(t) === tag))
      )
      const limit = num(a.limit, 80)
      return {
        content: list.length
          ? `${list.length} note${list.length > limit ? ` (mostro le prime ${limit})` : ''}:\n` + list.slice(0, limit).map((n) => `- [[${n.title}]]`).join('\n')
          : 'Nessuna nota con questi filtri.',
        summary: `${list.length} note`,
        ids: list.slice(0, limit).map((n) => n.id)
      }
    }
  },
  {
    name: 'find_path',
    description: 'Find the shortest chain of links that connects two notes, to explain how two concepts are related.',
    parameters: { type: 'object', properties: { from: noteParam, to: noteParam }, required: ['from', 'to'] },
    label: (a) => `Percorso «${str(a.from)}» → «${str(a.to)}»`,
    activity: (a) => `Cerco un percorso da «${str(a.from)}» a «${str(a.to)}»`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const from = noteOrError(k, a.from)
      if (!('id' in from)) return from
      const to = noteOrError(k, a.to)
      if (!('id' in to)) return to
      const path = k.path(from.id, to.id)
      if (!path) return { content: 'Le due note non sono collegate da nessun percorso di link (entro 8 passi).', summary: 'Nessun percorso', ids: [from.id, to.id] }
      return { content: `Percorso (${path.length - 1} passi): ${path.map((x) => link(k, x)).join(' → ')}`, summary: `${path.length - 1} passi`, ids: path }
    }
  },
  {
    name: 'suggest_links',
    description:
      'Find notes whose content is related to a note but that are NOT linked to it yet: candidates for new connections. Use read_note on the candidates to verify before proposing or creating links.',
    parameters: { type: 'object', properties: { note: noteParam, limit: { type: 'integer', description: 'Max candidates (default 8)' } }, required: ['note'] },
    label: (a) => `Collegamenti mancanti per «${str(a.note)}»`,
    activity: (a) => `Cerco note affini a «${str(a.note)}»`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const r = noteOrError(k, a.note)
      if (!('id' in r)) return r
      const sims = k.similar(r.id, num(a.limit, 8))
      if (!sims.length) return { content: 'Nessun candidato trovato.', summary: 'Nessun candidato', ids: [r.id] }
      return {
        content: sims
          .map((s, i) => `${i + 1}. ${link(k, s.id)}${k.nodes.get(s.id)?.corso ? ` (${k.nodes.get(s.id)!.corso})` : ''} — affinità ${s.score}${s.shared.length ? `, termini comuni: ${s.shared.join(', ')}` : ''}`)
          .join('\n'),
        summary: `${sims.length} candidati`,
        ids: [r.id, ...sims.map((s) => s.id)]
      }
    }
  },

  /* writes: every one goes through ctx.approve() */
  {
    name: 'create_note',
    write: true,
    description:
      'Create a new note (neuron). One note = one concept, short, written in your own words, following the vault rules. Fails if a note with the same title already exists: then use update_note or append_to_note. Link related notes inside the content with [[Title]].',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Concept name, used as file name' },
        content: { type: 'string', description: 'Markdown body (without frontmatter)' },
        area: { type: 'string', description: 'Area for the frontmatter (e.g. Università)' },
        corso: { type: 'string', description: 'Course for the frontmatter, if any' },
        tags: { type: 'array', items: { type: 'string' } },
        related: { type: 'array', items: { type: 'string' }, description: 'Titles of existing notes to link from the new note' },
        folder: { type: 'string', description: 'Optional vault folder; default: Neuroni/<area>' }
      },
      required: ['title', 'content']
    },
    label: (a) => `Crea la nota «${str(a.title)}»`,
    activity: (a) => `Creo «${str(a.title)}»${str(a.folder) ? ` in ${str(a.folder)}` : where(a)}`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const title = cleanTitle(str(a.title))
      if (!title) return { content: 'Titolo mancante.', summary: 'Titolo mancante', ids: [] }
      const existing = k.resolveNote(title)
      if ('id' in existing && normalize(k.title(existing.id)) === normalize(title))
        return { content: `Esiste già la nota ${link(k, existing.id)}: usa update_note o append_to_note.`, summary: 'Esiste già', ids: [existing.id] }
      const corso = str(a.corso)
      const area = str(a.area) || majorityArea(k, corso)
      let folder = str(a.folder).replace(/^\/+|\/+$/g, '')
      if (!folder) {
        if (area && existsSync(join(ctx.vaultPath, 'Neuroni', area))) folder = `Neuroni/${area}`
        else if (existsSync(join(ctx.vaultPath, 'Neuroni'))) folder = 'Neuroni'
      }
      const id = (folder ? folder + '/' : '') + title + '.md'
      if (existsSync(safeVaultPath(ctx.vaultPath, id))) return { content: `Il file ${id} esiste già.`, summary: 'Esiste già', ids: [id] }
      const doc = new Document({ ...(area ? { area } : {}), ...(corso ? { corso } : {}) })
      const fm = withTags(doc.toString(), strList(a.tags))
      let body = str(a.content)
      if (!/^#\s/.test(body)) body = `# ${title}\n\n${body}`
      // links requested through `related` that the text does not already contain
      const related = (Array.isArray(a.related) ? a.related : [])
        .map((r) => k.resolveNote(str(r)))
        .filter((r): r is { id: string } => 'id' in r)
        .map((r) => link(k, r.id))
        .filter((l, i, all) => !body.includes(l) && all.indexOf(l) === i)
      if (related.length) body += `\n\nVedi anche: ${related.join(' · ')}`
      return applyWrite(ctx, 'create_note', id, compose(fm, body), true)
    }
  },
  {
    name: 'update_note',
    write: true,
    description:
      'Rewrite the body of an existing note and/or replace its tags. The frontmatter is preserved. Read the note first and keep everything that should stay.',
    parameters: {
      type: 'object',
      properties: {
        note: noteParam,
        content: { type: 'string', description: 'New full Markdown body (without frontmatter)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tag list' }
      },
      required: ['note']
    },
    label: (a) => `Modifica «${str(a.note)}»`,
    activity: (a) => `Modifico «${str(a.note)}»`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const r = noteOrError(k, a.note)
      if (!('id' in r)) return r
      const src = await fs.readFile(safeVaultPath(ctx.vaultPath, r.id), 'utf8')
      const { fm, body } = splitRaw(src)
      const tags = a.tags !== undefined ? strList(a.tags) : null
      let newBody = a.content !== undefined ? str(a.content) : body
      if (!newBody.trim()) return { content: 'Contenuto vuoto: non cancello la nota.', summary: 'Contenuto vuoto', ids: [r.id] }
      const heading = /^\s*(#\s[^\n]*)/.exec(body)?.[1]
      if (a.content !== undefined && heading && !/^\s*#\s/.test(newBody)) newBody = `${heading}\n\n${newBody}`
      return applyWrite(ctx, 'update_note', r.id, compose(tags ? withTags(fm, tags) : fm, newBody), false)
    }
  },
  {
    name: 'append_to_note',
    write: true,
    description: 'Append a paragraph (Markdown) at the end of an existing note, keeping the rest unchanged.',
    parameters: { type: 'object', properties: { note: noteParam, text: { type: 'string' } }, required: ['note', 'text'] },
    label: (a) => `Aggiunge testo a «${str(a.note)}»`,
    activity: (a) => `Aggiungo testo a «${str(a.note)}»`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const r = noteOrError(k, a.note)
      if (!('id' in r)) return r
      const text = str(a.text)
      if (!text) return { content: 'Testo vuoto.', summary: 'Testo vuoto', ids: [r.id] }
      const src = await fs.readFile(safeVaultPath(ctx.vaultPath, r.id), 'utf8')
      const { fm, body } = splitRaw(src)
      return applyWrite(ctx, 'append_to_note', r.id, compose(fm, body.trimEnd() + '\n\n' + text), false)
    }
  },
  {
    name: 'link_notes',
    write: true,
    description:
      'Create a link (synapse) from one note to another by appending a sentence that contains [[to]] to the "from" note. Provide a short sentence explaining the relation.',
    parameters: {
      type: 'object',
      properties: { from: noteParam, to: noteParam, sentence: { type: 'string', description: 'Sentence explaining the relation; [[to]] is added if missing' } },
      required: ['from', 'to']
    },
    label: (a) => `Collega «${str(a.from)}» → «${str(a.to)}»`,
    activity: (a) => `Collego «${str(a.from)}» a «${str(a.to)}»`,
    async run(a, ctx) {
      const k = ctx.knowledge()
      const from = noteOrError(k, a.from)
      if (!('id' in from)) return from
      const to = noteOrError(k, a.to)
      if (!('id' in to)) return to
      if (from.id === to.id) return { content: 'Non posso collegare una nota a se stessa.', summary: 'Stessa nota', ids: [from.id] }
      if (k.out.get(from.id)?.has(to.id)) return { content: `${link(k, from.id)} contiene già un link a ${link(k, to.id)}.`, summary: 'Già collegate', ids: [from.id, to.id] }
      const target = link(k, to.id)
      let sentence = str(a.sentence)
      if (!sentence) sentence = `Vedi anche: ${target}`
      else if (!sentence.includes('[[')) sentence = `${sentence} (${target})`
      const src = await fs.readFile(safeVaultPath(ctx.vaultPath, from.id), 'utf8')
      const { fm, body } = splitRaw(src)
      const res = await applyWrite(ctx, 'link_notes', from.id, compose(fm, body.trimEnd() + '\n\n' + sentence), false)
      return { ...res, ids: [from.id, to.id] }
    }
  }
]

function majorityArea(k: VaultKnowledge, corso: string): string {
  const counts = new Map<string, number>()
  for (const n of k.nodes.values()) {
    if (!n.area) continue
    if (corso && normalize(n.corso ?? '') !== normalize(corso)) continue
    counts.set(n.area, (counts.get(n.area) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

export function toolSpecs(readOnly = false): ToolSpec[] {
  return TOOLS.filter((t) => !readOnly || !t.write).map(({ name, description, parameters }) => ({ name, description, parameters }))
}
