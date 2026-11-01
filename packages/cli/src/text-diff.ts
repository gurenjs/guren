/**
 * A unified diff of two texts by line, for printing: `-` lines are `before`'s, `+` lines `after`'s,
 * each hunk with `context` unchanged lines around it. An LCS table, so it is meant for files of a
 * few hundred lines (a copied component), not for whole trees. Empty when the texts are equal.
 */
export function unifiedDiff(
  before: string,
  after: string,
  { fromLabel, toLabel, context = 3 }: { fromLabel: string; toLabel: string; context?: number },
): string {
  const a = before.replace(/\r\n/gu, '\n').split('\n')
  const b = after.replace(/\r\n/gu, '\n').split('\n')
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const ops: { kind: ' ' | '-' | '+'; text: string; aLine: number; bLine: number }[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i]!, aLine: i++, bLine: j++ })
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ kind: '+', text: b[j]!, aLine: i, bLine: j++ })
    } else {
      ops.push({ kind: '-', text: a[i]!, aLine: i++, bLine: j })
    }
  }
  if (ops.every((op) => op.kind === ' ')) return ''

  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`]
  let index = 0
  while (index < ops.length) {
    const firstChange = ops.findIndex((op, at) => at >= index && op.kind !== ' ')
    if (firstChange === -1) break
    const start = Math.max(index, firstChange - context)
    let end = firstChange
    for (let at = firstChange; at < ops.length; at++) {
      if (ops[at]!.kind !== ' ') end = at
      else if (at - end > context * 2) break
    }
    end = Math.min(ops.length - 1, end + context)
    const hunk = ops.slice(start, end + 1)
    const aCount = hunk.filter((op) => op.kind !== '+').length
    const bCount = hunk.filter((op) => op.kind !== '-').length
    lines.push(`@@ -${hunk[0]!.aLine + 1},${aCount} +${hunk[0]!.bLine + 1},${bCount} @@`)
    for (const op of hunk) lines.push(`${op.kind}${op.text}`)
    index = end + 1
  }
  return `${lines.join('\n')}\n`
}
