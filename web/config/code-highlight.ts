/**
 * Fence info attributes (```` ```ts file=a.ts highlight=3-5,9 ````) and the
 * `highlight=` line ranges. The docs renderer and `audit:tutorial-blocks`
 * (scripts/smoke/tutorial-blocks.ts) both read them through this module.
 */
const RANGE = /^(\d+)(?:-(\d+))?$/u

export const HIGHLIGHT_PREFIX = 'highlight='

export type HighlightLines = { lines: Set<number> } | { error: string }

/** The value of the first `name=value` token after the language, or null when there is none. */
export function fenceAttribute(info: string | undefined, name: string): string | null {
  const prefix = `${name}=`
  const token = (info ?? '').split(/\s+/u).slice(1).find((part) => part.startsWith(prefix) && part.length > prefix.length)
  return token === undefined ? null : token.slice(prefix.length)
}

/** As shiki numbers them: a trailing newline opens one more, empty line. */
export function codeLineCount(code: string): number {
  return code.split('\n').length
}

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
  return { lines }
}
