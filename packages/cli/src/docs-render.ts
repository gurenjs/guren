/**
 * Markdown-subset renderer for the docs viewer (RFC 0005).
 *
 * Covers what the OKF docs convention produces: headings, paragraphs,
 * bullet lists (one nesting level), pipe tables, fenced code, and the
 * inline spans below. Deliberately not a CommonMark engine — the docs
 * convention is a controlled vocabulary (same philosophy as the
 * frontmatter parser in `docs-index.ts`), so holes found in practice are
 * cheaper to patch than a markdown dependency is to carry.
 *
 * Mermaid fences pass through as `<pre class="mermaid">` for the viewer
 * to render client-side; local link targets are surfaced via
 * `data-target` so the viewer can wire graph navigation onto them.
 */
import { readLinkDestination } from './docs-index'

/**
 * Escapes for both element and attribute contexts — quotes included,
 * since link targets are interpolated into a `data-target="…"` value and
 * doc content is attacker-controllable in the general case (a bundle can
 * be vendored, shared, or agent-written).
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Inline spans, applied to raw (unescaped) text. */
function inline(text: string, resolveLink?: (target: string) => string): string {
  const out: string[] = []
  let index = 0

  while (index < text.length) {
    const open = text.indexOf('[', index)
    if (open === -1) break

    const close = text.indexOf(']', open)
    const destination =
      close !== -1 && text[close + 1] === '(' ? readLinkDestination(text, close + 1) : null
    if (destination === null) {
      // Not a link after all — the slice still has to be escaped, or a
      // stray `[` anywhere in the document would leave everything
      // before it as raw markup.
      out.push(spans(text.slice(index, open + 1)))
      index = open + 1
      continue
    }

    out.push(spans(text.slice(index, open)))
    const label = spans(text.slice(open + 1, close))
    const target = resolveLink ? resolveLink(destination.target) : destination.target
    out.push(`<a class="md-link" data-target="${escapeHtml(target)}">${label}</a>`)
    index = destination.end + 1
  }

  out.push(spans(text.slice(index)))
  return out.join('')
}

/** Code, bold, and emphasis over a link-free slice. */
function spans(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
}

function renderTable(rows: string[], resolveLink?: (target: string) => string): string {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => inline(cell.trim(), resolveLink))

  const [head, , ...body] = rows
  const thead = `<thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead>`
  const tbody = body
    .map((row) => `<tr>${cells(row).map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')
  return `<div class="table-scroll"><table>${thead}${tbody === '' ? '' : `<tbody>${tbody}</tbody>`}</table></div>`
}

/**
 * Render a doc body (frontmatter already stripped) to HTML. Headings
 * shift down one level (`#` → `<h2>`) so the viewer's panel title keeps
 * the single `<h1>` slot.
 */
export interface RenderDocOptions {
  /**
   * Maps a markdown link destination to the value emitted in
   * `data-target`. The viewer passes the app-root path the link resolves
   * to, so navigation is a map lookup rather than a second, divergent
   * implementation of the resolution rules.
   */
  resolveLink?: (target: string) => string
}

export function renderDocHtml(source: string, options: RenderDocOptions = {}): string {
  const { resolveLink } = options
  const lines = source.split('\n')
  const out: string[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      out.push(
        lang === 'mermaid'
          ? `<pre class="mermaid">${escapeHtml(body.join('\n'))}</pre>`
          : `<pre class="code"><code>${escapeHtml(body.join('\n'))}</code></pre>`,
      )
      continue
    }

    if (line.trimStart().startsWith('|') && (lines[index + 1] ?? '').includes('---')) {
      const rows: string[] = []
      while (index < lines.length && lines[index].trimStart().startsWith('|')) {
        rows.push(lines[index])
        index += 1
      }
      out.push(renderTable(rows, resolveLink))
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6)
      out.push(`<h${level}>${inline(heading[2], resolveLink)}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = /^(\s*)[-*]\s+(.*)$/.exec(lines[index])!
        const nested = item[1].length >= 2 ? ' class="nested"' : ''
        items.push(`<li${nested}>${inline(item[2], resolveLink)}</li>`)
        index += 1
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    if (line.trim() === '' || line.trimStart().startsWith('<!--')) {
      index += 1
      continue
    }

    const paragraph: string[] = []
    while (
      index < lines.length
      && lines[index].trim() !== ''
      && !lines[index].startsWith('```')
      && !/^#{1,6}\s/.test(lines[index])
      && !/^\s*[-*]\s+/.test(lines[index])
      && !lines[index].trimStart().startsWith('|')
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(' '), resolveLink)}</p>`)
  }

  return out.join('\n')
}
