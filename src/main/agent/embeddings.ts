import { t } from '@shared/i18n'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { NoteText } from '../vault'

interface Meta {
  model: string
  dim: number
  ids: string[]
  mtimes: number[]
}

/** Text that represents a note for embedding: title, metadata and the start of the body. */
export function embeddingText(note: NoteText): string {
  const fm = note.frontmatter
  const meta = [fm.corso, fm.area, Array.isArray(fm.tags) ? fm.tags.join(', ') : fm.tags].filter(Boolean).join(' · ')
  return `${note.title}\n${meta}\n\n${note.body.slice(0, 2400)}`
}

/** Normalised embedding vectors for every note, persisted next to the app data. */
export class EmbeddingIndex {
  private rows = new Map<string, number>()

  constructor(
    readonly model: string,
    readonly dim: number,
    private ids: string[],
    private mtimes: number[],
    private vecs: Float32Array
  ) {
    ids.forEach((id, i) => this.rows.set(id, i))
  }

  get size(): number {
    return this.ids.length
  }

  static files(dataDir: string, vaultPath: string, model: string): { meta: string; bin: string } {
    const key = createHash('sha1').update(vaultPath + '\u0000' + model).digest('hex').slice(0, 16)
    const dir = join(dataDir, 'index')
    return { meta: join(dir, key + '.json'), bin: join(dir, key + '.bin') }
  }

  static async load(dataDir: string, vaultPath: string, model: string): Promise<EmbeddingIndex | null> {
    const f = EmbeddingIndex.files(dataDir, vaultPath, model)
    try {
      const meta = JSON.parse(await fs.readFile(f.meta, 'utf8')) as Meta
      const buf = await fs.readFile(f.bin)
      const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice()
      if (vecs.length !== meta.ids.length * meta.dim) return null
      return new EmbeddingIndex(meta.model, meta.dim, meta.ids, meta.mtimes, vecs)
    } catch {
      return null
    }
  }

  async save(dataDir: string, vaultPath: string): Promise<void> {
    const f = EmbeddingIndex.files(dataDir, vaultPath, this.model)
    await fs.mkdir(join(dataDir, 'index'), { recursive: true })
    const meta: Meta = { model: this.model, dim: this.dim, ids: this.ids, mtimes: this.mtimes }
    await fs.writeFile(f.meta, JSON.stringify(meta))
    await fs.writeFile(f.bin, Buffer.from(this.vecs.buffer, this.vecs.byteOffset, this.vecs.byteLength))
  }

  /** Notes that are new or changed since they were embedded. */
  stale(notes: Iterable<NoteText>): NoteText[] {
    const out: NoteText[] = []
    for (const n of notes) {
      const row = this.rows.get(n.id)
      if (row === undefined || this.mtimes[row] !== n.mtime) out.push(n)
    }
    return out
  }

  /** Builds or refreshes the index for `notes`, dropping notes that no longer exist. */
  static async build(
    previous: EmbeddingIndex | null,
    model: string,
    notes: NoteText[],
    embed: (texts: string[]) => Promise<number[][]>,
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<EmbeddingIndex> {
    const keep = previous && previous.model === model ? previous : null
    const todo = keep ? keep.stale(notes) : notes
    const fresh = new Map<string, Float32Array>()
    let dim = keep?.dim ?? 0
    const batch = 16
    for (let i = 0; i < todo.length; i += batch) {
      if (signal?.aborted) throw new Error(t('Indicizzazione annullata'))
      const slice = todo.slice(i, i + batch)
      const vectors = await embed(slice.map(embeddingText))
      vectors.forEach((v, k) => {
        dim = v.length
        fresh.set(slice[k].id, normalizeVec(Float32Array.from(v)))
      })
      onProgress?.(Math.min(i + batch, todo.length), todo.length)
    }
    const ids: string[] = []
    const mtimes: number[] = []
    const vecs = new Float32Array(notes.length * dim)
    notes.forEach((n) => {
      const v = fresh.get(n.id) ?? keep?.vectorOf(n.id)
      if (!v || v.length !== dim) return
      vecs.set(v, ids.length * dim)
      ids.push(n.id)
      mtimes.push(n.mtime)
    })
    return new EmbeddingIndex(model, dim, ids, mtimes, vecs.slice(0, ids.length * dim))
  }

  vectorOf(id: string): Float32Array | null {
    const row = this.rows.get(id)
    return row === undefined ? null : this.vecs.subarray(row * this.dim, (row + 1) * this.dim)
  }

  /** Cosine similarity against every note (vectors are normalised). */
  query(vec: Float32Array, k: number): [string, number][] {
    if (vec.length !== this.dim) return []
    const q = normalizeVec(Float32Array.from(vec))
    const scores: [string, number][] = []
    for (let r = 0; r < this.ids.length; r++) {
      let dot = 0
      const o = r * this.dim
      for (let j = 0; j < this.dim; j++) dot += q[j] * this.vecs[o + j]
      scores.push([this.ids[r], dot])
    }
    scores.sort((a, b) => b[1] - a[1])
    return scores.slice(0, k)
  }
}

function normalizeVec(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}
