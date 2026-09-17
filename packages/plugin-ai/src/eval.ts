/**
 * `@guren/plugin-ai/eval` (RFC 0029 §10): the opt-in eval surface. A fake (§7) proves the
 * wiring; an eval calls the real model over a case set with a grader, on purpose and at a
 * cost. Neither substitutes for the other, and no `guren check` or `guren gate` runs this.
 */
export { defineEval, fromJsonl, isEvalDefinition, parseJsonlCases } from './eval-define'
export { EvalRunError, runEval } from './eval-run'
export type { EvalRunResult, RunEvalOptions } from './eval-run'
export { HILLCLIMB_ROOT, hillclimbReporter } from './eval-reporter'
export type { HillclimbReporterOptions } from './eval-reporter'
export { addUsage, computeCostUsd, sumCosts, toEvalUsage } from './eval-cost'
export { formatSummary, summarizeMetrics, totalCostUsd, totalJudgeCostUsd, totalUsage } from './eval-stats'
export type {
  EvalAppHandle,
  EvalCase,
  EvalCaseSource,
  EvalContainer,
  EvalDefinition,
  EvalFailure,
  EvalFailureClass,
  EvalGradeContext,
  EvalJudge,
  EvalMetric,
  EvalMetricSummary,
  EvalPricing,
  EvalReporter,
  EvalReporterHandle,
  EvalRow,
  EvalRowStatus,
  EvalRunContext,
  EvalScores,
  EvalSummary,
  EvalTraceTurn,
  EvalUsage,
} from './eval-types'
