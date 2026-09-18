/**
 * `@guren/plugin-ai/eval` (RFC 0029 §10): the opt-in eval surface. A fake (§7) proves the
 * wiring; an eval calls the real model over a case set with a grader, on purpose and at a
 * cost. Neither substitutes for the other, and no `guren check` or `guren gate` runs this.
 */
export { defineEval, fromJsonl, parseJsonlCases } from './eval-define'
export { EvalRunError, runEval } from './eval-run'
export type { EvalRunResult, RunEvalOptions } from './eval-run'
export { hillclimbReporter } from './eval-reporter'
export type { HillclimbReporterOptions } from './eval-reporter'
export { formatSummary } from './eval-stats'
export { EVAL_KIND } from './eval-types'
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
