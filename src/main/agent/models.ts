import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import type { BuiltinModelInfo, ModelDownloadProgress } from '@shared/types'

/** A model the app can download and run by itself (no Ollama needed). */
export interface CatalogModel {
  id: string
  label: string
  file: string
  url: string
  /** Bytes of the GGUF file. */
  size: number
  sha256: string
  /** Total RAM (GB) from which this is the recommended model. */
  minRamGb: number
}

/*
 * Qwen 3.5 (Apache-2.0, redistribution allowed) quantized by Unsloth.
 * URLs are pinned to a repository revision, so the checksum never changes under our feet.
 */
export const CATALOG: CatalogModel[] = [
  {
    id: 'qwen3.5-4b',
    label: 'Qwen 3.5 4B',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf',
    size: 2740937888,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    minRamGb: 0
  },
  {
    id: 'qwen3.5-9b',
    label: 'Qwen 3.5 9B',
    file: 'Qwen3.5-9B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf',
    size: 5680522464,
    sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    minRamGb: 24
  }
]

export const modelsDir = (dataDir: string): string => join(dataDir, 'models')

export function catalogModel(id: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === id)
}

/** The biggest model that comfortably fits in this machine's memory. */
export function recommendedModel(): CatalogModel {
  const gb = totalmem() / 1024 ** 3
  return [...CATALOG].sort((a, b) => b.minRamGb - a.minRamGb).find((m) => gb >= m.minRamGb) ?? CATALOG[0]
}

/** A file counts as installed only with the exact size: a truncated or replaced one does not. */
export async function installedModels(dataDir: string): Promise<string[]> {
  const dir = modelsDir(dataDir)
  const sizes = await Promise.all(CATALOG.map((m) => stat(join(dir, m.file)).then((s) => s.size, () => -1)))
  return CATALOG.filter((m, i) => sizes[i] === m.size).map((m) => m.id)
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Next to each verified model: its checksum, size and mtime, so it is hashed again only if it changes. */
interface VerifiedMark {
  sha256: string
  size: number
  mtimeMs: number
}

async function markVerified(path: string, m: CatalogModel): Promise<void> {
  const s = await stat(path)
  const mark: VerifiedMark = { sha256: m.sha256, size: s.size, mtimeMs: s.mtimeMs }
  await writeFile(path + '.ok', JSON.stringify(mark))
}

/**
 * Checks a model against its checksum and deletes it when it does not match, so the panel offers
 * the download again. A damaged file can crash llama.cpp's loader, so this runs before the first load;
 * it reads the whole file (a few seconds) only when the file is new or changed since the last check.
 */
export async function verifyModel(dataDir: string, id: string): Promise<boolean> {
  const m = catalogModel(id)
  if (!m) return false
  const path = join(modelsDir(dataDir), m.file)
  const [s, mark] = await Promise.all([
    stat(path).catch(() => null),
    readFile(path + '.ok', 'utf8').then((t) => JSON.parse(t) as VerifiedMark, () => null)
  ])
  if (!s) return false
  if (mark && mark.sha256 === m.sha256 && mark.size === s.size && mark.mtimeMs === s.mtimeMs) return true
  const ok = s.size === m.size && (await sha256(path).then((d) => d === m.sha256, () => false))
  if (ok) await markVerified(path, m)
  else await Promise.all([rm(path, { force: true }), rm(path + '.ok', { force: true })])
  return ok
}

const GB = 1e9
/** Room left on the disk after the download, for the system and the app's own files. */
const DISK_MARGIN = 0.5 * GB

async function ensureSpace(dir: string, bytes: number): Promise<void> {
  const fs = await statfs(dir).catch(() => null)
  if (!fs) return
  const free = fs.bavail * fs.bsize
  if (free < bytes + DISK_MARGIN) {
    const fmt = (b: number): string => (b / GB).toFixed(1).replace('.', ',')
    throw new Error(`Spazio su disco insufficiente: servono ${fmt(bytes + DISK_MARGIN)} GB liberi, ce ne sono ${fmt(free)}. Libera spazio e riprova.`)
  }
}

export async function modelInfo(dataDir: string): Promise<BuiltinModelInfo> {
  const installed = new Set(await installedModels(dataDir))
  const dir = modelsDir(dataDir)
  const models = await Promise.all(
    CATALOG.map(async (m) => {
      const partial = await stat(join(dir, m.file + '.part')).then((s) => s.size, () => 0)
      return { id: m.id, label: m.label, size: m.size, installed: installed.has(m.id), partial }
    })
  )
  return { models, recommended: recommendedModel().id, ramGb: Math.round(totalmem() / 1024 ** 3) }
}

/**
 * Downloads a catalog model into the data folder. Resumes a previous partial download
 * (HTTP Range) and checks the SHA-256 before making the file available.
 */
export async function downloadModel(
  dataDir: string,
  id: string,
  onProgress: (p: ModelDownloadProgress) => void,
  signal: AbortSignal
): Promise<string> {
  const m = catalogModel(id)
  if (!m) throw new Error(`Modello sconosciuto: ${id}`)
  const dir = modelsDir(dataDir)
  await mkdir(dir, { recursive: true })
  const final = join(dir, m.file)
  const part = final + '.part'
  const existing = await stat(final).then((s) => s.size, () => -1)
  if (existing === m.size) {
    onProgress({ id, received: m.size, total: m.size, phase: 'done' })
    return final
  }
  // a final file with the wrong size is damaged: this download replaces it
  if (existing >= 0) await Promise.all([rm(final, { force: true }), rm(final + '.ok', { force: true })])

  // hash what is already on disk, so the checksum covers the whole file
  let hash = createHash('sha256')
  let have = await stat(part).then((s) => s.size, () => 0)
  if (have > m.size) {
    await rm(part, { force: true })
    have = 0
  }
  await ensureSpace(dir, m.size - have)
  if (have) {
    onProgress({ id, received: have, total: m.size, phase: 'verifying' })
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer)
  }

  if (have < m.size) {
    const res = await fetch(m.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal })
    if (!res.ok || !res.body) throw new Error(`Download non riuscito (HTTP ${res.status})`)
    if (have && res.status !== 206) {
      // the server ignored the range: start over
      have = 0
      hash = createHash('sha256')
    }
    const out = createWriteStream(part, { flags: have ? 'a' : 'w' })
    let received = have
    let last = 0
    let lastBytes = received
    let lastTime = Date.now()
    let speed = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        received += chunk.length
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
        const now = Date.now()
        if (now - last > 250) {
          if (now - lastTime > 1000) {
            speed = ((received - lastBytes) / (now - lastTime)) * 1000
            lastBytes = received
            lastTime = now
          }
          last = now
          onProgress({ id, received, total: m.size, phase: 'downloading', speed })
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
    if (received !== m.size) throw new Error('Download incompleto: riprova per riprendere da dove si è fermato.')
  }

  onProgress({ id, received: m.size, total: m.size, phase: 'verifying' })
  const digest = hash.digest('hex')
  if (digest !== m.sha256) {
    await rm(part, { force: true })
    throw new Error('Il file scaricato è danneggiato (checksum diverso). Riprova il download.')
  }
  await rename(part, final)
  await markVerified(final, m)
  onProgress({ id, received: m.size, total: m.size, phase: 'done' })
  return final
}
