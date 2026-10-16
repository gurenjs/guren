/**
 * The one reading and writing of generated blocks fenced by `<!-- guren:<name> … -->` markers in a
 * markdown document, shared by `plan:close` (`guren:plan`) and `browser:map` (`guren:browser`,
 * RFC 0033 §2). Headings, fences and markers are read through `markdownLines()`, the one fence rule.
 */

import { markdownLines } from './docs-links'

export interface MarkerSyntax<T> {
  /** The marker's name as problems print it: `guren:plan`. */
  name: string
  /** The block key an open marker names and what else it carries, or `undefined` when the line is not one. */
  open(line: string): { key: string; data: T } | undefined
  /** The block key a close marker names, or `undefined` when the line is not one. */
  close(line: string): string | undefined
}

export interface MarkerBlock<T> {
  data: T
  /** Lines of the open and close markers, in `lines`. */
  open: number
  close: number
}

export interface MarkedLines<T> {
  lines: string[]
  inFence: boolean[]
  eol: '\n' | '\r\n'
  /** In document order: blocks cannot nest, so they are stored as they close. */
  blocks: Map<string, MarkerBlock<T>>
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u

/**
 * The document's lines and its blocks, or what makes its markers unsafe to rewrite: an open
 * marker with no close before the next marker or heading, a close with no open, a pair that
 * appears twice, a marker inside a code fence, a fence that never closes. Any of these, and a
 * rewrite could delete a person's text or never converge, so the caller refuses rather than guesses.
 */
export function readMarkedLines<T>(document: string, syntax: MarkerSyntax<T>): { doc: MarkedLines<T>; problems: string[] } {
  const scanned = markdownLines(document)
  const doc: MarkedLines<T> = {
    lines: scanned.lines.map((line) => line.text),
    inFence: scanned.lines.map((line) => line.inFence),
    eol: document.includes('\r\n') ? '\r\n' : '\n',
    blocks: new Map(),
  }
  // Everything after an unclosed fence reads as code, so a block written there would be code too.
  if (scanned.unclosedFence !== undefined) return { doc, problems: [`line ${scanned.unclosedFence + 1}: a code fence opens here and never closes`] }
  const problems: string[] = []
  let open: { key: string; line: number; data: T } | undefined
  const unclosed = (): void => {
    if (open) problems.push(`line ${open.line + 1}: the block "${open.key}" opens and never closes`)
    open = undefined
  }
  doc.lines.forEach((text, index) => {
    const opening = syntax.open(text)
    const closing = syntax.close(text)
    if ((opening || closing !== undefined) && doc.inFence[index]) {
      problems.push(`line ${index + 1}: a ${syntax.name} marker sits inside a code fence`)
      return
    }
    if (opening) {
      unclosed()
      open = { key: opening.key, line: index, data: opening.data }
    } else if (closing !== undefined) {
      if (open?.key !== closing) {
        unclosed()
        problems.push(`line ${index + 1}: the block "${closing}" closes and never opened`)
      } else if (doc.blocks.has(closing)) {
        problems.push(`line ${open.line + 1}: the block "${closing}" appears twice`)
        open = undefined
      } else {
        doc.blocks.set(closing, { data: open.data, open: open.line, close: index })
        open = undefined
      }
    } else if (!doc.inFence[index] && HEADING.test(text)) {
      unclosed()
    }
  })
  unclosed()
  return { doc, problems }
}

/**
 * The lines with block `key` set to `fenced` (its markers included): replaced where it exists,
 * otherwise inserted at the end of the `## ` section whose heading is one of `headings`, or
 * appended under `## <newHeading>`. `fenced` absent removes an existing block, with the blank
 * line this writer put before it. No text outside a block is rewritten.
 */
export function spliceMarkedBlock<T>(
  doc: MarkedLines<T>,
  key: string,
  fenced: readonly string[] | undefined,
  options: { headings: ReadonlySet<string>; newHeading: string },
): string[] {
  const { lines } = doc
  const existing = doc.blocks.get(key)
  if (existing) {
    if (fenced) return [...lines.slice(0, existing.open), ...fenced, ...lines.slice(existing.close + 1)]
    const start = existing.open > 0 && lines[existing.open - 1] === '' ? existing.open - 1 : existing.open
    return [...lines.slice(0, start), ...lines.slice(existing.close + 1)]
  }
  if (!fenced) return lines

  const heading = lines.findIndex((line, index) => {
    const match = doc.inFence[index] ? null : HEADING.exec(line)
    return match !== null && match[1] === '##' && options.headings.has(match[2])
  })
  if (heading === -1) {
    let end = lines.length
    while (end > 0 && lines[end - 1] === '') end--
    return [...lines.slice(0, end), '', `## ${options.newHeading}`, '', ...fenced, '']
  }
  let next = lines.findIndex((line, index) => index > heading && !doc.inFence[index] && /^#{1,2}\s/u.test(line))
  if (next === -1) next = lines.length
  let last = next - 1
  while (last > heading && lines[last].trim() === '') last--
  const tail = lines.slice(next)
  return [...lines.slice(0, last + 1), '', ...fenced, ...(tail.length > 0 ? ['', ...tail] : [''])]
}
