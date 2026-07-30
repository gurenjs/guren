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

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Inline spans, applied to already-escaped text. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_match, label: string, target: string) =>
        `<a class="md-link" data-target="${target}">${label}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
}

function renderTable(rows: string[]): string {
  const cells = (row: string): string[] =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => inline(escapeHtml(cell.trim())))

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
export function renderDocHtml(source: string): string {
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
      out.push(renderTable(rows))
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6)
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = /^(\s*)[-*]\s+(.*)$/.exec(lines[index])!
        const nested = item[1].length >= 2 ? ' class="nested"' : ''
        items.push(`<li${nested}>${inline(escapeHtml(item[2]))}</li>`)
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
    if (paragraph.length > 0) out.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`)
  }

  return out.join('\n')
}
