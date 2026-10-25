import { t } from '@shared/i18n'
import { promises as fs } from 'node:fs'
import { basename, extname, join, posix, relative, sep, isAbsolute } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { GraphLink, GraphNode, NodeKind, VaultGraph } from '@shared/types'

interface ScannedFile {
  id: string // posix path relative to vault, with extension
  abs: string
  ext: string
  mtime: number
}

interface ParsedNote {
  file: ScannedFile
  frontmatter: Record<string, unknown>
  body: string
  rawLinks: string[]
}

const IGNORED_DIRS = new Set(['node_modules'])

async function walk(root: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = []
  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(
      entries.map(async (e) => {
        if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) return
        const abs = join(dir, e.name)
        if (e.isDirectory()) return visit(abs)
        if (!e.isFile()) return
        const stat = await fs.stat(abs).catch(() => null)
        out.push({
          id: relative(root, abs).split(sep).join('/'),
          abs,
          ext: extname(e.name).toLowerCase(),
          mtime: stat?.mtimeMs ?? 0
        })
      })
    )
  }
  await visit(root)
  return out
}

export function splitFrontmatter(src: string): { frontmatter: Record<string, unknown>; body: string } {
  const text = src.replace(/^﻿/, '')
  if (!text.startsWith('---')) return { frontmatter: {}, body: text }
  const end = text.search(/\n---[ \t]*(\r?\n|$)/)
  if (end === -1) return { frontmatter: {}, body: text }
  const yamlBlock = text.slice(3, end)
  const body = text.slice(end).replace(/^\n---[ \t]*\r?\n?/, '')
  try {
    const parsed = parseYaml(yamlBlock)
    return { frontmatter: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}, body }
  } catch {
    return { frontmatter: {}, body }
  }
}

const WIKILINK_RE = /!?\[\[([^\]\n]+?)\]\]/g
const MDLINK_RE = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '')
}

/** Extracts link targets (without alias / heading / block refs). */
export function extractLinks(body: string): string[] {
  const text = stripCode(body)
  const links: string[] = []
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1].split('|')[0].split('#')[0].split('^')[0].trim()
    if (target) links.push(target)
  }
  for (const m of text.matchAll(MDLINK_RE)) {
    let target = m[1]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue
    target = target.split('#')[0]
    try {
      target = decodeURIComponent(target)
    } catch {
      /* keep raw */
    }
    if (target) links.push(target)
  }
  return links
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).replace(/^#/, '').trim()).filter(Boolean)
  if (typeof v === 'string')
    return v
      .split(/[,\s]+/)
      .map((x) => x.replace(/^#/, '').trim())
      .filter(Boolean)
  return []
}

const INLINE_TAG_RE = /(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu

function inlineTags(body: string): string[] {
  const text = stripCode(body)
  const tags: string[] = []
  for (const m of text.matchAll(INLINE_TAG_RE)) tags.push(m[1])
  return tags
}

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number') return String(v)
  return undefined
}

export class Resolver {
  private byPath = new Map<string, string>()
  private byName = new Map<string, string[]>() // basename with extension
  private byNoteName = new Map<string, string[]>() // md basename without extension

  constructor(files: ScannedFile[]) {
    for (const f of files) {
      const lower = f.id.toLowerCase()
      this.byPath.set(lower, f.id)
      const name = basename(lower)
      push(this.byName, name, f.id)
      if (f.ext === '.md') push(this.byNoteName, name.slice(0, -3), f.id)
    }
  }

  resolve(target: string, fromId: string): string | null {
    const t = target.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase()
    if (!t) return null
    const fromDir = posix.dirname(fromId.toLowerCase())
    const candidates = t.endsWith('.md') ? [t] : [t + '.md', t]

    if (t.includes('/')) {
      for (const c of candidates) {
        const rel = posix.normalize(posix.join(fromDir, c))
        const hit = this.byPath.get(rel) ?? this.byPath.get(posix.normalize(c).replace(/^\//, ''))
        if (hit) return hit
      }
      // Obsidian also accepts partial paths ("Folder/Note") matching the end of a path.
      for (const c of candidates) {
        const ids = this.byName.get(posix.basename(c))
        const match = ids?.filter((id) => id.toLowerCase().endsWith('/' + c) || id.toLowerCase() === c)
        if (match?.length) return pickClosest(match, fromDir)
      }
      return null
    }

    const notes = t.endsWith('.md') ? this.byNoteName.get(t.slice(0, -3)) : this.byNoteName.get(t)
    if (notes?.length) return pickClosest(notes, fromDir)
    const files = this.byName.get(t)
    if (files?.length) return pickClosest(files, fromDir)
    return null
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key)
  if (arr) arr.push(value)
  else map.set(key, [value])
}

function pickClosest(ids: string[], fromDir: string): string {
  if (ids.length === 1) return ids[0]
  const same = ids.find((id) => posix.dirname(id.toLowerCase()) === fromDir)
  if (same) return same
  return [...ids].sort((a, b) => a.length - b.length)[0]
}

function countWords(body: string): number {
  const m = body.match(/[\p{L}\p{N}]+/gu)
  return m ? m.length : 0
}

/** Text of a note kept in memory for search and for the AI agent. */
export interface NoteText {
  id: string
  title: string
  body: string
  frontmatter: Record<string, unknown>
  mtime: number
}

export interface VaultScan {
  graph: Omit<VaultGraph, 'positions'>
  resolver: Resolver
  notes: Map<string, NoteText>
}

export async function scanVault(vaultPath: string): Promise<VaultScan> {
  const files = await walk(vaultPath)
  const resolver = new Resolver(files)
  const mdFiles = files.filter((f) => f.ext === '.md')

  const parsed: ParsedNote[] = await Promise.all(
    mdFiles.map(async (file) => {
      const src = await fs.readFile(file.abs, 'utf8').catch(() => '')
      const { frontmatter, body } = splitFrontmatter(src)
      return { file, frontmatter, body, rawLinks: extractLinks(body) }
    })
  )

  const nodes = new Map<string, GraphNode>()
  const fileById = new Map(files.map((f) => [f.id, f]))

  for (const { file, frontmatter, body } of parsed) {
    const title = basename(file.id, '.md')
    const folder = file.id.includes('/') ? file.id.split('/')[0] : ''
    const isMoc = folder.toLowerCase() === 'moc' || /^moc\b/i.test(title)
    const area = str(frontmatter.area)
    const corso = str(frontmatter.corso) ?? (isMoc ? title.replace(/^moc\s+/i, '') : undefined)
    const tags = Array.from(new Set([...toStringArray(frontmatter.tags ?? frontmatter.tag), ...inlineTags(body)]))
    nodes.set(file.id, {
      id: file.id,
      title,
      kind: isMoc ? 'moc' : 'note',
      folder,
      area,
      corso,
      tags,
      group: corso ?? area ?? (folder || 'Vault'),
      words: countWords(body),
      mtime: file.mtime
    })
  }

  const linkKeys = new Set<string>()
  const links: GraphLink[] = []
  const addNode = (id: string, kind: NodeKind, title: string): void => {
    if (nodes.has(id)) return
    const f = fileById.get(id)
    nodes.set(id, {
      id,
      title,
      kind,
      folder: id.includes('/') ? id.split('/')[0] : '',
      tags: [],
      group: '',
      words: 0,
      mtime: f?.mtime ?? 0
    })
  }

  for (const { file, rawLinks } of parsed) {
    for (const raw of rawLinks) {
      let target = resolver.resolve(raw, file.id)
      if (target && !target.endsWith('.md')) addNode(target, 'attachment', basename(target))
      if (!target) {
        target = 'unresolved:' + raw.toLowerCase()
        addNode(target, 'unresolved', raw)
      }
      if (target === file.id) continue
      const key = file.id < target ? file.id + '\u0000' + target : target + '\u0000' + file.id
      if (linkKeys.has(key)) continue
      linkKeys.add(key)
      links.push({ source: file.id, target })
    }
  }

  // Attachments and unresolved links inherit the dominant group of the notes pointing at them.
  const votes = new Map<string, Map<string, number>>()
  for (const l of links) {
    for (const [a, b] of [
      [l.source, l.target],
      [l.target, l.source]
    ]) {
      const node = nodes.get(a)
      const other = nodes.get(b)
      if (!node || !other || node.group || !other.group) continue
      const m = votes.get(a) ?? new Map<string, number>()
      m.set(other.group, (m.get(other.group) ?? 0) + 1)
      votes.set(a, m)
    }
  }
  for (const node of nodes.values()) {
    if (node.group) continue
    const m = votes.get(node.id)
    node.group = m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : node.kind === 'unresolved' ? t('Non risolti') : t('Fonti')
  }

  return {
    graph: {
      vaultPath,
      vaultName: basename(vaultPath),
      nodes: [...nodes.values()],
      links,
      scannedAt: Date.now()
    },
    resolver,
    notes: new Map(
      parsed.map(({ file, frontmatter, body }) => [
        file.id,
        { id: file.id, title: basename(file.id, '.md'), body, frontmatter, mtime: file.mtime }
      ])
    )
  }
}

/** Maps every raw link target found in a note to the node id it points at. */
export function resolveNoteLinks(resolver: Resolver, id: string, markdown: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of extractLinks(splitFrontmatter(markdown).body)) {
    out[raw] = resolver.resolve(raw, id) ?? 'unresolved:' + raw.toLowerCase()
  }
  return out
}

/** Returns the absolute path for a vault-relative id, refusing anything outside the vault. */
export function safeVaultPath(vaultPath: string, id: string): string {
  const abs = join(vaultPath, ...id.split('/'))
  const rel = relative(vaultPath, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(t('Percorso fuori dal vault'))
  return abs
}
