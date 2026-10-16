import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked'
import markedKatex from 'marked-katex-extension'
import DOMPurify from 'dompurify'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

let currentLinks: Record<string, string> = {}
let nodeExists: (id: string) => boolean = () => false

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export const vaultUrl = (id: string): string => 'vault://file/' + id.split('/').map(encodeURIComponent).join('/')

interface WikiToken extends Tokens.Generic {
  embed: boolean
  target: string
  alias: string
}

const wikilink: TokenizerAndRendererExtension = {
  name: 'wikilink',
  level: 'inline',
  start(src: string) {
    const i = src.indexOf('[[')
    if (i < 0) return undefined
    return i > 0 && src[i - 1] === '!' ? i - 1 : i
  },
  tokenizer(src: string) {
    const m = /^(!?)\[\[([^\]\n]+?)\]\]/.exec(src)
    if (!m) return undefined
    const [target, ...aliasParts] = m[2].split('|')
    return {
      type: 'wikilink',
      raw: m[0],
      embed: m[1] === '!',
      target: target.trim(),
      alias: aliasParts.join('|').trim()
    } satisfies WikiToken
  },
  renderer(token) {
    const t = token as WikiToken
    const key = t.target.split('#')[0].split('^')[0].trim()
    const id = currentLinks[key]
    const heading = t.target.includes('#') ? t.target.slice(t.target.indexOf('#') + 1) : ''
    const label = escapeHtml(t.alias || (key ? key.split('/').pop()!.replace(/\.md$/i, '') : heading) + (heading && !t.alias && key ? ' › ' + heading : ''))
    if (!id || id.startsWith('unresolved:')) return `<span class="wikilink unresolved" title="Nota non ancora creata">${label}</span>`
    if (!id.endsWith('.md')) {
      if (t.embed && IMAGE_EXT.test(id)) return `<img class="embed" src="${vaultUrl(id)}" alt="${label}" loading="lazy" />`
      return `<a class="wikilink file" data-file="${escapeHtml(id)}" title="${escapeHtml(id)}">${label}</a>`
    }
    const cls = nodeExists(id) ? 'wikilink' : 'wikilink hidden-node'
    return `<a class="${cls}" data-node="${escapeHtml(id)}">${label}</a>`
  }
}

const marked = new Marked({ gfm: true, breaks: false })
marked.use({ extensions: [wikilink] })
marked.use(markedKatex({ throwOnError: false, nonStandard: true, output: 'html' }))

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')?.match(/^https?:/i)) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer')
  }
})

export function renderMarkdown(md: string, links: Record<string, string>, exists: (id: string) => boolean): string {
  currentLinks = links
  nodeExists = exists
  // Obsidian highlights (==text==) and comments (%%text%%)
  const prepared = md.replace(/%%[\s\S]*?%%/g, '').replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
  const html = marked.parse(prepared, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['data-node', 'data-file', 'target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|vault):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
  })
}

/** Turns Obsidian callouts (> [!note] Title) into styled boxes. */
export function decorateCallouts(root: HTMLElement): void {
  root.querySelectorAll('blockquote').forEach((bq) => {
    const first = bq.firstElementChild
    if (!first || first.tagName !== 'P') return
    const m = /^\[!(\w+)\][+-]?\s*([^\n]*)/.exec(first.textContent ?? '')
    if (!m) return
    const type = m[1].toLowerCase()
    bq.classList.add('callout', 'callout-' + type)
    const title = document.createElement('div')
    title.className = 'callout-title'
    title.textContent = m[2] || type.charAt(0).toUpperCase() + type.slice(1)
    // strip the marker line from the first paragraph
    const html = first.innerHTML.replace(/^\[!\w+\][+-]?[^\n<]*(<br>|\n)?/, '')
    first.innerHTML = html
    if (!first.textContent?.trim()) first.remove()
    bq.prepend(title)
  })
}
