/**
 * `defineEval()` and the case sources (RFC 0029 §10). Declaration only: everything
 * that runs lives in `eval-run.ts`, so an eval file costs a module import.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Agent, AgentClass } from './agent'
import {
  EVAL_KIND,
  type EvalAppHandle,
  type EvalCase,
  type EvalDefinition,
  type EvalScores,
} from './eval-types'

/**
 * An eval: an agent, a disposable app per case, a case set, and a grader that reads the
 * end state those cases left behind. Opt-in, and never part of `guren check` or
 * `guren gate`, because every case calls the model.
 * @example defineEval({ agent, app, cases: fromJsonl(path), grade, metrics })
 */
export function defineEval<
  // oxlint-disable-next-line typescript/no-explicit-any -- any Agent subclass, whatever its scopes parameter
  TAgent extends Agent<any>,
  TApp extends EvalAppHandle,
  TCase extends EvalCase,
  TScores extends EvalScores,
>(
  definition: Omit<EvalDefinition<TAgent, TApp, TCase, TScores>, 'kind' | 'agent'> & { agent: AgentClass<TAgent> },
): EvalDefinition<TAgent, TApp, TCase, TScores> {
  if (definition.metrics.length === 0) {
    throw new Error(
      'defineEval({ metrics }) is empty, so a run would produce rows nothing reads. '
      + 'List the ids grade() returns, each as { id, kind: \'binary\' | \'score\' }.',
    )
  }
  const seen = new Set<string>()
  for (const metric of definition.metrics) {
    if (seen.has(metric.id)) {
      throw new Error(`defineEval({ metrics }) declares "${metric.id}" twice; a metric is summarized once.`)
    }
    seen.add(metric.id)
  }
  return { ...definition, kind: EVAL_KIND }
}

/** True for a `defineEval()` result from any copy of this package. */
export function isEvalDefinition(value: unknown): value is EvalDefinition {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === EVAL_KIND
}

/**
 * Cases from a JSONL file, one `{ id, input, expected?, seed?, tags? }` per line. Read when
 * the run starts, not at import, so a missing file fails the command rather than the module.
 * `--cases N` takes the first N in file order, so the order here is the one that runs.
 */
export function fromJsonl<TCase extends EvalCase>(path: string, options: { cwd?: string } = {}): () => TCase[] {
  return () => {
    const absolute = resolve(options.cwd ?? process.cwd(), path)
    let text: string
    try {
      text = readFileSync(absolute, 'utf8')
    } catch (error) {
      throw new Error(`Could not read eval cases from ${absolute}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return parseJsonlCases<TCase>(text, absolute)
  }
}

/** {@link fromJsonl}'s parser, separately for a caller that already holds the text. */
export function parseJsonlCases<TCase extends EvalCase>(text: string, source = '(inline)'): TCase[] {
  const cases: TCase[] = []
  const ids = new Set<string>()
  const lines = text.split('\n')
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(`${source}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
    const kase = parsed as Partial<EvalCase>
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${source}:${index + 1} is not a JSON object; each line is one case.`)
    }
    if (typeof kase.id !== 'string' || kase.id === '') {
      throw new Error(`${source}:${index + 1} has no string \`id\`; results and traces are keyed on it.`)
    }
    if (typeof kase.input !== 'string') {
      throw new Error(`${source}:${index + 1} (${kase.id}) has no string \`input\`; that is what the agent is prompted with.`)
    }
    if (ids.has(kase.id)) {
      throw new Error(`${source}:${index + 1} repeats the case id "${kase.id}"; a later row would overwrite the earlier one's trace.`)
    }
    ids.add(kase.id)
    cases.push(kase as TCase)
  }
  return cases
}
