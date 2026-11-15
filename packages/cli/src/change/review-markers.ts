/**
 * The generated block of `REVIEW.md` (RFC 0040 §7), apart from what fills it: `change:lane` reads
 * the markers to tell an edit to the author's rules from a regenerated block, and must not load
 * the graph or the audit readers that `review-doc.ts` imports.
 */
import { readMarkedLines, spliceMarkedBlock, type MarkerSyntax } from '../marker-blocks'

export const REVIEW_DOC_FILE = 'REVIEW.md'
export const REVIEW_BLOCK = 'generated'
export const REVIEW_SECTION = 'What this application holds'

export const REVIEW_MARKERS: MarkerSyntax<undefined> = {
  name: 'guren:review',
  open(line) {
    const match = /^<!-- guren:review (\S+) -->$/u.exec(line)
    return match ? { key: match[1]!, data: undefined } : undefined
  },
  close(line) {
    return /^<!-- \/guren:review (\S+) -->$/u.exec(line)?.[1]
  },
}

export function fenced(content: readonly string[]): string[] {
  return [`<!-- guren:review ${REVIEW_BLOCK} -->`, ...content, `<!-- /guren:review ${REVIEW_BLOCK} -->`]
}

/** The document with its generated block emptied, so two versions compare on the author's text; `undefined` when its markers do not read. */
export function reviewDocAuthorText(text: string): string | undefined {
  const { doc, problems } = readMarkedLines(text, REVIEW_MARKERS)
  if (problems.length > 0) return undefined
  return spliceMarkedBlock(doc, REVIEW_BLOCK, fenced([]), { headings: new Set([REVIEW_SECTION]), newHeading: REVIEW_SECTION }).join('\n')
}
