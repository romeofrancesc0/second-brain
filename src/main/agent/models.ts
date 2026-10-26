import { getLang, t } from '@shared/i18n'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import type { BuiltinModelInfo, ModelDownloadProgress } from '@shared/types'

/** A file the app downloads and checks. */
export interface CatalogFile {
  file: string
  url: string
  /** Bytes of the GGUF file. */
  size: number
  sha256: string
}

/** A model the app can download and run by itself (no Ollama needed). */
export interface CatalogModel extends CatalogFile {
  id: string
  label: string
  /** Total RAM (GB) from which this is the recommended model. */
  minRamGb: number
  /** Vision projector (mmproj): lets the model read images. Downloaded together with the model. */
  vision: CatalogFile
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
    minRamGb: 0,
    vision: {
      file: 'Qwen3.5-4B-mmproj-F16.gguf',
      url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/mmproj-F16.gguf',
      size: 672423616,
      sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864'
    }
  },
  {
    id: 'qwen3.5-9b',
    label: 'Qwen 3.5 9B',
    file: 'Qwen3.5-9B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf',
    size: 5680522464,
    sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    minRamGb: 24,
    vision: {
      file: 'Qwen3.5-9B-mmproj-F16.gguf',
      url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/mmproj-F16.gguf',
      size: 918166080,
      sha256: 'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f'
    }
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

async function markVerified(path: string, f: CatalogFile): Promise<void> {
  const s = await stat(path)
  const mark: VerifiedMark = { sha256: f.sha256, size: s.size, mtimeMs: s.mtimeMs }
  await writeFile(path + '.ok', JSON.stringify(mark))
}

/**
 * Checks a model against its checksum and deletes it when it does not match, so the panel offers
 * the download again. A damaged file can crash llama.cpp's loader, so this runs before the first load;
 * it reads the whole file (a few seconds) only when the file is new or changed since the last check.
 */
export async function verifyModel(dataDir: string, id: string): Promise<boolean> {
  const m = catalogModel(id)
  return m ? verifyFile(modelsDir(dataDir), m) : false
}

/** The model's vision file, when it is on disk and intact; null otherwise (the model then reads text only). */
export async function installedVision(dataDir: string, id: string): Promise<string | null> {
  const m = catalogModel(id)
  if (!m) return null
  const dir = modelsDir(dataDir)
  return (await verifyFile(dir, m.vision)) ? join(dir, m.vision.file) : null
}

async function verifyFile(dir: string, m: CatalogFile): Promise<boolean> {
  const path = join(dir, m.file)
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
    const fmt = (b: number): string => (b / GB).toFixed(1).replace('.', getLang() === 'en' ? '.' : ',')
    throw new Error(t('Spazio su disco insufficiente: servono {need} GB liberi, ce ne sono {free}. Libera spazio e riprova.', { need: fmt(bytes + DISK_MARGIN), free: fmt(free) }))
  }
}

export async function modelInfo(dataDir: string): Promise<BuiltinModelInfo> {
  const installed = new Set(await installedModels(dataDir))
  const dir = modelsDir(dataDir)
  const size = (f: string): Promise<number> => stat(join(dir, f)).then((s) => s.size, () => 0)
  const models = await Promise.all(
    CATALOG.map(async (m) => {
      const [partModel, partVision, vision] = await Promise.all([size(m.file + '.part'), size(m.vision.file + '.part'), size(m.vision.file)])
      // what a download still has to fetch: the model if missing, and the vision file
      const done = (installed.has(m.id) ? m.size : partModel) + (vision === m.vision.size ? m.vision.size : partVision)
      return {
        id: m.id,
        label: m.label,
        size: m.size + m.vision.size,
        installed: installed.has(m.id),
        vision: vision === m.vision.size,
        visionSize: m.vision.size,
        partial: done < m.size + m.vision.size ? done : 0
      }
    })
  )
  return { models, recommended: recommendedModel().id, ramGb: Math.round(totalmem() / 1024 ** 3) }
}

/**
 * Downloads a catalog model and its vision file into the data folder. Resumes a previous partial
 * download (HTTP Range) and checks each SHA-256 before making the file available. Files already on
 * disk are skipped, so this also adds the vision file to a model downloaded before it existed.
 */
export async function downloadModel(
  dataDir: string,
  id: string,
  onProgress: (p: ModelDownloadProgress) => void,
  signal: AbortSignal
): Promise<string> {
  const m = catalogModel(id)
  if (!m) throw new Error(t('Modello sconosciuto: {id}', { id }))
  const dir = modelsDir(dataDir)
  await mkdir(dir, { recursive: true })
  const files = [m, m.vision]
  const total = files.reduce((a, f) => a + f.size, 0)
  const sizes = await Promise.all(files.map((f) => stat(join(dir, f.file)).then((s) => s.size, () => -1)))
  const todo = files.filter((_, i) => sizes[i] !== files[i].size)
  const parts = await Promise.all(todo.map((f) => stat(join(dir, f.file + '.part')).then((s) => Math.min(s.size, f.size), () => 0)))
  await ensureSpace(dir, todo.reduce((a, f, i) => a + f.size - parts[i], 0))

  let before = total - todo.reduce((a, f) => a + f.size, 0)
  for (const f of todo) {
    await downloadFile(dir, f, signal, (received, phase, speed) => onProgress({ id, received: before + received, total, phase, speed }))
    before += f.size
  }
  onProgress({ id, received: total, total, phase: 'done' })
  return join(dir, m.file)
}

async function downloadFile(
  dir: string,
  f: CatalogFile,
  signal: AbortSignal,
  progress: (received: number, phase: 'downloading' | 'verifying', speed?: number) => void
): Promise<void> {
  const final = join(dir, f.file)
  const part = final + '.part'
  // a final file with the wrong size is damaged: this download replaces it
  await Promise.all([rm(final, { force: true }), rm(final + '.ok', { force: true })])

  // hash what is already on disk, so the checksum covers the whole file
  let hash = createHash('sha256')
  let have = await stat(part).then((s) => s.size, () => 0)
  if (have > f.size) {
    await rm(part, { force: true })
    have = 0
  }
  if (have) {
    progress(have, 'verifying')
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer)
  }

  if (have < f.size) {
    const res = await fetch(f.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal })
    if (!res.ok || !res.body) throw new Error(t('Download non riuscito (HTTP {status})', { status: res.status }))
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
          progress(received, 'downloading', speed)
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
    if (received !== f.size) throw new Error(t('Download incompleto: riprova per riprendere da dove si è fermato.'))
  }

  progress(f.size, 'verifying')
  if (hash.digest('hex') !== f.sha256) {
    await rm(part, { force: true })
    throw new Error(t('Il file scaricato è danneggiato (checksum diverso). Riprova il download.'))
  }
  await rename(part, final)
  await markVerified(final, f)
}
