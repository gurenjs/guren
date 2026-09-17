/**
 * The summary an eval run prints and writes (RFC 0029 §10).
 *
 * The half-width is the eval method's own rule of thumb, `1/sqrt(n)` over the rows that
 * entered the mean, printed so a two-point move on twenty cases reads as the noise it is.
 * It is not a confidence interval and carries no level; reps of one case tighten sampling
 * noise and nothing else, which is why the rows, not the cases, are what n counts.
 */
import { addUsage, sumCosts } from './eval-cost'
import type { EvalMetric, EvalMetricSummary, EvalRow, EvalUsage } from './eval-types'

export function summarizeMetrics(rows: readonly EvalRow[], metrics: readonly EvalMetric[]): EvalMetricSummary[] {
  // Truncation is plumbing, not a model result: a variant must not improve by truncating more.
  const scored = rows.filter((row) => row.status === 'ok')
  return metrics.map((metric) => {
    const values = scored.map((row) => row.scores[metric.id]).filter((value): value is number => typeof value === 'number')
    const n = values.length
    const mean = n === 0 ? 0 : values.reduce((total, value) => total + value, 0) / n
    return {
      id: metric.id,
      kind: metric.kind,
      mean,
      n,
      ...(metric.kind === 'binary' && n > 0 ? { halfWidth: 1 / Math.sqrt(n) } : {}),
    }
  })
}

export function totalUsage(rows: readonly EvalRow[]): EvalUsage {
  return rows.reduce<EvalUsage>((total, row) => addUsage(total, row.usage), {})
}

export function totalCostUsd(rows: readonly EvalRow[]): number | undefined {
  return sumCosts(rows.flatMap((row) => [row.costUsd, row.judgeCostUsd]))
}

export function totalJudgeCostUsd(rows: readonly EvalRow[]): number | undefined {
  return sumCosts(rows.map((row) => row.judgeCostUsd))
}

/** The headline, one metric per line, with the truncated and failed counts beside it. */
export function formatSummary(summary: {
  flow: string
  variant: string
  cases: number
  reps: number
  rows: number
  truncated: number
  failures: number
  metrics: readonly EvalMetricSummary[]
  costUsd?: number
  durationMs: number
}): string {
  const lines = [
    `${summary.flow}/${summary.variant}  ${summary.cases} cases x ${summary.reps} reps = ${summary.rows} rows`,
  ]
  const width = Math.max(0, ...summary.metrics.map((metric) => metric.id.length))
  for (const metric of summary.metrics) {
    const halfWidth = metric.halfWidth === undefined ? '' : `  +/-${metric.halfWidth.toFixed(2)} approx half-width (1/sqrt(n))`
    lines.push(`  ${metric.id.padEnd(width)}  ${metric.mean.toFixed(3)}  n=${metric.n}${halfWidth}`)
  }
  const cost = summary.costUsd === undefined ? 'cost n/a (no pricing)' : `cost $${summary.costUsd.toFixed(4)}`
  lines.push(`  truncated ${summary.truncated}   errors ${summary.failures}   ${cost}   ${(summary.durationMs / 1000).toFixed(1)}s`)
  return lines.join('\n')
}
