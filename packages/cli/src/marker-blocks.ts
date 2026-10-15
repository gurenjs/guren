/**
 * The one reading of generated blocks fenced by `<!-- guren:<name> … -->` markers in a markdown
 * document, shared by `plan:close` (`guren:plan`) and `browser:map` (`guren:browser`, RFC 0033 §2).
 * Headings, fences and markers are read through `markdownLines()`, the one fence rule.
 */

import { markdownLines } from './docs-links'

export interface MarkerSyntax {
  /** The marker's name as problems print it: `guren:plan`. */
  name: string
  /** The block key an open marker names, or `undefined` when the line is not one. */
  open(line: string): { key: string; match: RegExpExecArray } | undefined
  /** The block key a close marker names, or `undefined` when the line is not one. */
  close(line: string): string | undefined
}

export interface MarkerBlock {
  key: string
  /** The open marker's match, for the arguments a syntax carries beyond its key. */
  match: RegExpExecArray
  /** Lines of the open and close markers, in `lines`. */
  open: number
  close: number
}

export interface MarkedLines {
  lines: string[]
  inFence: boolean[]
  eol: '\n' | '\r\n'
  blocks: Map<string, MarkerBlock>
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u

/**
 * The document's lines and its blocks, or what makes its markers unsafe to rewrite: an open
 * marker with no close before the next marker or heading, a close with no open, a pair that
 * appears twice, a marker inside a code fence, a fence that never closes. Any of these, and a
 * rewrite could delete a person's text or never converge, so the caller refuses rather than guesses.
 */
export function readMarkedLines(document: string, syntax: MarkerSyntax): { doc: MarkedLines; problems: string[] } {
  const scanned = markdownLines(document)
  const doc: MarkedLines = {
    lines: scanned.lines.map((line) => line.text),
    inFence: scanned.lines.map((line) => line.inFence),
    eol: document.includes('\r\n') ? '\r\n' : '\n',
    blocks: new Map(),
  }
  // Everything after an unclosed fence reads as code, so a block written there would be code too.
  if (scanned.unclosedFence !== undefined) return { doc, problems: [`line ${scanned.unclosedFence + 1}: a code fence opens here and never closes`] }
  const problems: string[] = []
  let open: { key: string; line: number; match: RegExpExecArray } | undefined
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
      open = { key: opening.key, line: index, match: opening.match }
    } else if (closing !== undefined) {
      if (open?.key !== closing) {
        unclosed()
        problems.push(`line ${index + 1}: the block "${closing}" closes and never opened`)
      } else if (doc.blocks.has(closing)) {
        problems.push(`line ${open.line + 1}: the block "${closing}" appears twice`)
        open = undefined
      } else {
        doc.blocks.set(closing, { key: closing, match: open.match, open: open.line, close: index })
        open = undefined
      }
    } else if (!doc.inFence[index] && HEADING.test(text)) {
      unclosed()
    }
  })
  unclosed()
  return { doc, problems }
}

/** The line of a heading of `level` whose text is one of `names`, outside code; -1 when none. */
export function findHeadingLine(doc: Pick<MarkedLines, 'lines' | 'inFence'>, level: number, names: ReadonlySet<string>): number {
  return doc.lines.findIndex((line, index) => {
    const heading = doc.inFence[index] ? null : HEADING.exec(line)
    return heading !== null && heading[1].length === level && names.has(heading[2])
  })
}
