/**
 * The `highlight=3-5,9` fence attribute: which lines of a code block the reader
 * should look at. The docs renderer marks them and `audit:tutorial-blocks`
 * (scripts/smoke/tutorial-blocks.ts) checks them, both through this parser.
 */
const HIGHLIGHT_ATTRIBUTE = /(?:^|\s)highlight=(\S*)/u
const RANGE = /^(\d+)(?:-(\d+))?$/u

export type HighlightLines = { lines: number[] } | { error: string }

/** Line numbers are 1-based and must fall inside the block's `lineCount` lines. */
export function parseHighlightLines(value: string, lineCount: number): HighlightLines {
  const lines = new Set<number>()
  for (const part of value.split(',')) {
    const match = RANGE.exec(part)
    if (!match) return { error: `highlight= takes line ranges like 3-5,9, got: ${value}` }
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (start < 1 || end < start) return { error: `highlight= range ${part} is empty or starts before line 1` }
    if (end > lineCount) return { error: `highlight= line ${end} is past the end of the block (${lineCount} lines)` }
    for (let line = start; line <= end; line++) lines.add(line)
  }
  return { lines: [...lines].sort((a, b) => a - b) }
}

/** The attribute's raw value on a fence info string, or null when it has none. */
export function highlightAttribute(info: string | undefined): string | null {
  const match = HIGHLIGHT_ATTRIBUTE.exec(info ?? '')
  return match ? match[1]! : null
}
