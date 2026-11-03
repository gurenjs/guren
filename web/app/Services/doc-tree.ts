import { escapeHtml } from '@guren/plugin-markdown'

/**
 * A ```tree fence: a directory listing drawn with `├──` / `└──` / `│` (four
 * columns a level) or plain two-space indents, one entry a line, a trailing
 * `/` marking a directory and ` # ` opening a note. GitHub shows the source as
 * it is; the site renders folders that fold, file badges and the notes.
 */
interface TreeEntry {
  name: string
  note: string | null
  depth: number
  children: TreeEntry[]
}

const BOX_PREFIX = /^[  │├└─]*/u
const NOTE_SEPARATOR = /\s+#\s+/u

const SVG = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`

const CHEVRON = SVG('<path d="m9 6 6 6-6 6"/>')
const FOLDER_OPEN = SVG(
  '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
)
const FOLDER = SVG(
  '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
)
const FILE = SVG(
  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
)

const BADGES: Array<[RegExp, string, string]> = [
  [/\.(?:ts|tsx|mts|cts)$/u, 'TS', 'ts'],
  [/\.(?:js|jsx|mjs|cjs)$/u, 'JS', 'js'],
  [/\.json$/u, '{}', 'json'],
  [/\.mdx?$/u, 'MD', 'md'],
]

function lineDepth(prefix: string): number {
  // Box drawing advances four columns a level; bare indentation, two.
  return /[│├└─]/u.test(prefix) ? Math.round(prefix.length / 4) : Math.floor(prefix.length / 2)
}

function parseTree(source: string): TreeEntry[] {
  const roots: TreeEntry[] = []
  const stack: TreeEntry[] = []
  for (const [index, raw] of source.split('\n').entries()) {
    if (raw.trim() === '') continue
    const prefix = BOX_PREFIX.exec(raw)![0]
    const depth = lineDepth(prefix)
    const [name, ...note] = raw.slice(prefix.length).trimEnd().split(NOTE_SEPARATOR)
    const parentDepth = stack.length === 0 ? -1 : stack[stack.length - 1]!.depth
    if (depth > parentDepth + 1) {
      throw new Error(`tree fence line ${index + 1} ("${raw.trim()}") is nested more than one level below the line above it`)
    }
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop()
    const entry: TreeEntry = { name: name!, note: note.length > 0 ? note.join(' # ') : null, depth, children: [] }
    if (stack.length === 0) roots.push(entry)
    else stack[stack.length - 1]!.children.push(entry)
    stack.push(entry)
  }
  return roots
}

/** Notes keep `code` spans; everything else is escaped text. */
function noteHtml(note: string): string {
  return escapeHtml(note).replace(/`([^`]+)`/gu, '<code>$1</code>')
}

function fileIcon(name: string): string {
  for (const [pattern, label, kind] of BADGES) {
    if (pattern.test(name)) return `<span class="doc-tree-badge doc-tree-badge--${kind}" aria-hidden="true">${label}</span>`
  }
  return `<span class="doc-tree-icon">${FILE}</span>`
}

function row(icon: string, entry: TreeEntry): string {
  const note = entry.note === null ? '' : `<span class="doc-tree-note">${noteHtml(entry.note)}</span>`
  return `${icon}<span class="doc-tree-name">${escapeHtml(entry.name)}</span>${note}`
}

function renderEntries(entries: TreeEntry[]): string {
  const items = entries.map((entry) => {
    if (entry.children.length > 0) {
      const summary = `<summary class="doc-tree-row"><span class="doc-tree-chevron">${CHEVRON}</span><span class="doc-tree-icon">${FOLDER_OPEN}</span>${row('', entry)}</summary>`
      return `<li><details open>${summary}${renderEntries(entry.children)}</details></li>`
    }
    const directory = entry.name.endsWith('/')
    const icon = directory ? `<span class="doc-tree-icon">${FOLDER}</span>` : fileIcon(entry.name)
    return `<li><span class="doc-tree-row doc-tree-row--leaf">${row(icon, entry)}</span></li>`
  })
  return `<ul>${items.join('')}</ul>`
}

/** Opens with `<pre` so the markdown plugin emits it as a highlighter's block. Throws on a line that skips a level. */
export function renderFileTree(source: string): string {
  return `<pre class="doc-tree">${renderEntries(parseTree(source))}</pre>`
}
