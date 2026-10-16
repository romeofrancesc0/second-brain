import { posix } from 'node:path'
import type { GraphNode } from '@shared/types'
import type { NoteText, VaultScan } from '../vault'
import type { EmbeddingIndex } from './embeddings'

// Short Italian + English stop-word list: enough to keep BM25 / TF-IDF focused on content words.
const STOP = new Set(
  (
    'il lo la i gli le un uno una di a da in con su per tra fra e ed o od ma se che chi cui non ne ci si mi ti vi del dello della dei degli delle ' +
    'al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle col coi è sono ' +
    'era essere ha hanno ho come anche più molto quando quindi questo questa questi queste quello quella quelli quelle cosa tutto tutti ogni ' +
    'sua suo suoi sue loro dove poi già solo tra fino oppure cioè ovvero può possono viene vengono fa fanno stato stata ' +
    'the of and or to in on for with is are be by as at an it this that from'
  ).split(' ')
)

export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export function tokenize(s: string): string[] {
  const out: string[] = []
  for (const t of normalize(s).split(/[^a-z0-9]+/)) if (t.length >= 2 && !STOP.has(t)) out.push(t)
  return out
}

export interface SearchHit {
  id: string
  title: string
  score: number
  corso?: string
  tags: string[]
  snippet: string
}

interface Doc {
  id: string
  len: number
  tf: Map<string, number>
}

/** In-memory view of the vault used by the agent tools: search, similarity, neighbours, paths. */
export class VaultKnowledge {
  readonly nodes: Map<string, GraphNode>
  readonly notes: Map<string, NoteText>
  readonly out = new Map<string, Set<string>>()
  readonly in = new Map<string, Set<string>>()
  embeddings: EmbeddingIndex | null = null

  private byTitle = new Map<string, string[]>()
  private docs: Doc[] = []
  private df = new Map<string, number>()
  private avgLen = 1
  private tfidf = new Map<string, Map<string, number>>()

  constructor(
    readonly vaultPath: string,
    readonly scan: VaultScan
  ) {
    this.nodes = new Map(scan.graph.nodes.map((n) => [n.id, n]))
    this.notes = scan.notes
    for (const l of scan.graph.links) {
      ;(this.out.get(l.source) ?? this.out.set(l.source, new Set()).get(l.source)!).add(l.target)
      ;(this.in.get(l.target) ?? this.in.set(l.target, new Set()).get(l.target)!).add(l.source)
    }
    for (const n of scan.graph.nodes) {
      if (n.kind !== 'note' && n.kind !== 'moc') continue
      const key = normalize(n.title)
      ;(this.byTitle.get(key) ?? this.byTitle.set(key, []).get(key)!).push(n.id)
    }
    this.buildIndex()
  }

  private buildIndex(): void {
    let total = 0
    for (const note of this.notes.values()) {
      const node = this.nodes.get(note.id)
      const title = tokenize(note.title)
      const meta = tokenize([node?.corso ?? '', ...(node?.tags ?? [])].join(' '))
      const body = tokenize(note.body)
      const tf = new Map<string, number>()
      const add = (tokens: string[], w: number): void => {
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + w)
      }
      add(title, 3)
      add(meta, 2)
      add(body, 1)
      const len = title.length * 3 + meta.length * 2 + body.length
      total += len
      this.docs.push({ id: note.id, len, tf })
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1
    const N = this.docs.length
    for (const d of this.docs) {
      const v = new Map<string, number>()
      let norm = 0
      for (const [t, f] of d.tf) {
        const w = (1 + Math.log(f)) * Math.log(1 + N / (this.df.get(t) ?? 1))
        v.set(t, w)
        norm += w * w
      }
      norm = Math.sqrt(norm) || 1
      for (const [t, w] of v) v.set(t, w / norm)
      this.tfidf.set(d.id, v)
    }
  }

  isNote(id: string): boolean {
    const k = this.nodes.get(id)?.kind
    return k === 'note' || k === 'moc'
  }

  /** Accepts a title, a vault path or a [[wikilink]]; returns the note id or suggestions. */
  resolveNote(ref: string): { id: string } | { error: string; suggestions: string[] } {
    const raw = String(ref ?? '')
      .trim()
      .replace(/^\[\[|\]\]$/g, '')
      .split('|')[0]
      .split('#')[0]
      .trim()
    if (!raw) return { error: 'Riferimento vuoto', suggestions: [] }
    const asPath = raw.endsWith('.md') ? raw : raw + '.md'
    if (this.notes.has(raw)) return { id: raw }
    if (this.notes.has(asPath)) return { id: asPath }
    const resolved = this.scan.resolver.resolve(raw, '')
    if (resolved && this.notes.has(resolved)) return { id: resolved }
    const byTitle = this.byTitle.get(normalize(posix.basename(raw, '.md')))
    if (byTitle?.length) return { id: byTitle[0] }
    const suggestions = this.search(raw, { limit: 5 }).map((h) => h.title)
    return { error: `Nota "${raw}" non trovata`, suggestions }
  }

  title(id: string): string {
    return this.nodes.get(id)?.title ?? posix.basename(id, '.md')
  }

  /** BM25 keyword search, optionally fused with semantic search (reciprocal rank fusion). */
  search(
    query: string,
    opts: { corso?: string; area?: string; tag?: string; limit?: number; queryVector?: Float32Array | null } = {}
  ): SearchHit[] {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 40)
    const terms = [...new Set(tokenize(query))]
    const N = this.docs.length
    const k1 = 1.3
    const b = 0.72
    const pass = (id: string): boolean => {
      const n = this.nodes.get(id)
      if (!n) return false
      if (opts.corso && normalize(n.corso ?? '') !== normalize(opts.corso)) return false
      if (opts.area && normalize(n.area ?? '') !== normalize(opts.area)) return false
      if (opts.tag && !n.tags.some((t) => normalize(t) === normalize(opts.tag!))) return false
      return true
    }

    const keyword: [string, number][] = []
    if (terms.length) {
      for (const d of this.docs) {
        if (!pass(d.id)) continue
        let score = 0
        for (const t of terms) {
          const f = d.tf.get(t)
          if (!f) continue
          const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))
          score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avgLen))
        }
        if (normalize(this.title(d.id)).includes(normalize(query.trim()))) score += 4
        if (score > 0) keyword.push([d.id, score])
      }
      keyword.sort((x, y) => y[1] - x[1])
    }

    let ranked: [string, number][] = keyword
    if (opts.queryVector && this.embeddings) {
      const semantic = this.embeddings.query(opts.queryVector, 60).filter(([id]) => pass(id))
      const fused = new Map<string, number>()
      keyword.slice(0, 60).forEach(([id], r) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + r)))
      semantic.forEach(([id], r) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + r)))
      ranked = [...fused.entries()].sort((x, y) => y[1] - x[1])
    }

    return ranked.slice(0, limit).map(([id, score]) => {
      const n = this.nodes.get(id)!
      return {
        id,
        title: n.title,
        score: Math.round(score * 1000) / 1000,
        corso: n.corso,
        tags: n.tags,
        snippet: this.snippet(this.notes.get(id)?.body ?? '', terms)
      }
    })
  }

  private snippet(body: string, terms: string[]): string {
    const clean = body.replace(/^#.*$/m, '').replace(/\s+/g, ' ').trim()
    const lower = normalize(clean)
    let at = -1
    for (const t of terms) {
      at = lower.indexOf(t)
      if (at >= 0) break
    }
    const start = Math.max(0, at - 80)
    const text = clean.slice(start, start + 240)
    return (start > 0 ? '…' : '') + text + (start + 240 < clean.length ? '…' : '')
  }

  /** Notes that look related to `id` but are not linked to it: semantic if an index exists, else TF-IDF. */
  similar(id: string, limit = 8): { id: string; score: number; shared: string[] }[] {
    const linked = new Set([...(this.out.get(id) ?? []), ...(this.in.get(id) ?? []), id])
    const vec = this.embeddings?.vectorOf(id)
    if (vec && this.embeddings) {
      return this.embeddings
        .query(vec, limit + linked.size + 5)
        .filter(([other]) => !linked.has(other) && this.isNote(other))
        .slice(0, limit)
        .map(([other, score]) => ({ id: other, score: Math.round(score * 1000) / 1000, shared: this.sharedTerms(id, other) }))
    }
    const v = this.tfidf.get(id)
    if (!v) return []
    const scored: [string, number][] = []
    for (const [other, w] of this.tfidf) {
      if (linked.has(other)) continue
      let dot = 0
      const [small, big] = v.size < w.size ? [v, w] : [w, v]
      for (const [t, x] of small) {
        const y = big.get(t)
        if (y) dot += x * y
      }
      if (dot > 0.05) scored.push([other, dot])
    }
    scored.sort((a, b) => b[1] - a[1])
    return scored.slice(0, limit).map(([other, score]) => ({
      id: other,
      score: Math.round(score * 1000) / 1000,
      shared: this.sharedTerms(id, other)
    }))
  }

  private sharedTerms(a: string, b: string): string[] {
    const va = this.tfidf.get(a)
    const vb = this.tfidf.get(b)
    if (!va || !vb) return []
    return [...va.entries()]
      .filter(([t]) => vb.has(t))
      .map(([t, w]) => [t, w * vb.get(t)!] as const)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([t]) => t)
  }

  /** Shortest chain of links between two notes (links followed in both directions). */
  path(from: string, to: string, maxDepth = 8): string[] | null {
    if (from === to) return [from]
    const prev = new Map<string, string>([[from, '']])
    let frontier = [from]
    for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
      const next: string[] = []
      for (const cur of frontier) {
        for (const nb of [...(this.out.get(cur) ?? []), ...(this.in.get(cur) ?? [])]) {
          if (prev.has(nb) || !this.isNote(nb)) continue
          prev.set(nb, cur)
          if (nb === to) {
            const chain = [to]
            let p = cur
            while (p) {
              chain.unshift(p)
              p = prev.get(p)!
            }
            return chain
          }
          next.push(nb)
        }
      }
      frontier = next
    }
    return null
  }

  courses(): { corso: string; notes: number; moc?: string }[] {
    const map = new Map<string, { corso: string; notes: number; moc?: string }>()
    for (const n of this.nodes.values()) {
      if (n.kind !== 'note' && n.kind !== 'moc') continue
      const key = n.group
      const entry = map.get(key) ?? { corso: key, notes: 0 }
      entry.notes++
      if (n.kind === 'moc') entry.moc = n.title
      map.set(key, entry)
    }
    return [...map.values()].sort((a, b) => b.notes - a.notes)
  }
}
