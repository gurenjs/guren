/**
 * The eval runner (RFC 0029 §10). What the framework owns here is small on purpose:
 * isolation, the real invocation, and structured outcomes. Everything about the on-disk
 * layout belongs to a reporter.
 *
 * Evals are opt-in and never part of `guren check` or `guren gate`: every case calls the
 * model, and a nondeterministic gate is not one a PR should pay for.
 */
import type { Agent, AgentResponse, BoundAgent, PromptOptions } from './agent'
import type { AiProviderConfig } from './config'
import type { AiManager } from './manager'
import { addUsage, computeCostUsd, sumCosts, toEvalUsage } from './eval-cost'
import { hillclimbReporter } from './eval-reporter'
import { formatSummary, summarizeMetrics, totalCostUsd, totalJudgeCostUsd, totalUsage } from './eval-stats'
import type {
  EvalAppHandle,
  EvalCase,
  EvalDefinition,
  EvalFailure,
  EvalFailureClass,
  EvalPricing,
  EvalReporterHandle,
  EvalRow,
  EvalSummary,
  EvalTraceTurn,
  EvalUsage,
} from './eval-types'

const DEFAULT_VARIANT = 'baseline'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRIES = 2
const BACKOFF_BASE_MS = 500

export interface RunEvalOptions {
  /** Overrides `defineEval({ flow })`; `guren ai:eval` passes the eval file's basename. */
  flow?: string
  variant?: string
  reps?: number
  /** Run only the first N cases, in file order. */
  cases?: number
  /** A soft ceiling: no new case starts once the derived cost crosses it. */
  maxCostUsd?: number
  concurrency?: number
  /** Resolve the cases and print what would run, writing nothing and calling no model. */
  dryRun?: boolean
  onWarning?: (message: string) => void
  onRow?: (row: EvalRow) => void
  onFailure?: (failure: EvalFailure) => void
}

export interface EvalRunResult {
  summary: EvalSummary
  /** This run's rows plus the ones it resumed over. */
  rows: EvalRow[]
  failures: EvalFailure[]
  /** Where the reporter put them, when it says. */
  location?: string
  /** The cases selected, whether or not they ran. */
  plannedCases: EvalCase[]
}

/** A defect in the run itself, as opposed to a case that produced nothing scorable. */
export class EvalRunError extends Error {
  override name = 'EvalRunError'
}

// oxlint-disable-next-line typescript/no-explicit-any -- the runner reads a definition whose generics it does not need
type AnyEvalDefinition = EvalDefinition<any, any, any, any>

export async function runEval(definition: AnyEvalDefinition, options: RunEvalOptions = {}): Promise<EvalRunResult> {
  const flow = options.flow ?? definition.flow
  if (!flow) {
    throw new EvalRunError('This eval has no flow name. Pass defineEval({ flow }), or run it through `guren ai:eval <flow>`.')
  }
  const variant = options.variant ?? DEFAULT_VARIANT
  const reps = Math.max(1, options.reps ?? 1)
  const concurrency = Math.max(1, options.concurrency ?? 1)
  const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = definition.retries ?? DEFAULT_RETRIES

  const all = typeof definition.cases === 'function' ? await definition.cases() : [...definition.cases]
  const selected = options.cases === undefined ? all : all.slice(0, options.cases)
  if (selected.length === 0) {
    throw new EvalRunError(`The eval "${flow}" resolved no cases; there is nothing to run.`)
  }

  const startedAt = new Date()
  const agentName = definition.agent.agentName ?? definition.agent.name
  const reporter = definition.reporter ?? hillclimbReporter({ onWarning: options.onWarning })
  // Opened before the first app, so a dry run reports its target directory without booting one.
  const handle = await reporter.begin({
    flow,
    variant,
    agentName,
    provider: definition.provider ?? '(the agent\'s own)',
    reps,
    // Every case, not the `--cases` selection: `_state.json` is written once and describes
    // the case set, so a first run capped at two must not fix the split at two ids forever.
    cases: all.map((kase) => ({ id: kase.id, tags: kase.tags })),
    metrics: definition.metrics,
    startedAt: startedAt.toISOString(),
    dryRun: Boolean(options.dryRun),
  })

  if (options.dryRun) {
    return dryRunResult({ definition, flow, variant, reps, selected, startedAt, handle })
  }

  const done = new Set(handle.completed.map((row) => `${row.caseId}#${row.rep}`))
  const rows: EvalRow[] = []
  const failures: EvalFailure[] = []
  const attempts: Array<{ kase: EvalCase; rep: number }> = []
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const kase of selected) {
      if (!done.has(`${kase.id}#${rep}`)) attempts.push({ kase, rep })
    }
  }

  let spentUsd = 0
  let capReached = false
  let pricingWarned = false
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      // A cap is a *soft* ceiling: this stops new cases only, and cases in flight complete.
      if (options.maxCostUsd !== undefined && spentUsd >= options.maxCostUsd) {
        if (next < attempts.length) capReached = true
        return
      }
      const attempt = attempts[next++]
      if (!attempt) return

      const outcome = await runCase(definition, attempt.kase, attempt.rep, {
        timeoutMs,
        retries,
        onPricingMissing: (provider) => {
          if (pricingWarned || options.maxCostUsd === undefined) return
          pricingWarned = true
          options.onWarning?.(
            `The provider "${provider}" configures no \`pricing\` in config/ai.ts, so no cost is derived `
            + `and --max-cost-usd ${options.maxCostUsd} cannot stop this run.`,
          )
        },
      })

      if ('row' in outcome) {
        spentUsd += (outcome.row.costUsd ?? 0) + (outcome.row.judgeCostUsd ?? 0)
        rows.push(outcome.row)
        await handle.row(outcome.row, outcome.trace)
        options.onRow?.(outcome.row)
      } else {
        failures.push(outcome.failure)
        await handle.failure(outcome.failure)
        options.onFailure?.(outcome.failure)
      }
    }
  }

  const buildSummary = (): EvalSummary => {
    const finishedAt = new Date()
    const allRows = [...handle.completed, ...rows]
    return {
      flow,
      variant,
      agentName,
      provider: definition.provider ?? '(the agent\'s own)',
      cases: selected.length,
      reps,
      rows: allRows.length,
      truncated: allRows.filter((row) => row.status === 'truncated').length,
      failures: failures.length,
      metrics: summarizeMetrics(allRows, definition.metrics),
      usage: totalUsage(allRows),
      ...maybe('costUsd', totalCostUsd(allRows)),
      ...maybe('judgeCostUsd', totalJudgeCostUsd(allRows)),
      ...maybe('costCapUsd', options.maxCostUsd),
      ...(capReached ? { costCapReached: true } : {}),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    }
  }

  // Written even when a runner failure stops the run: a summary.json left disagreeing with
  // the results.jsonl beside it describes a run that never happened.
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, attempts.length) }, worker))
  } finally {
    await handle.end(buildSummary())
  }

  return {
    summary: buildSummary(),
    rows: [...handle.completed, ...rows],
    failures,
    ...maybe('location', handle.location),
    plannedCases: selected,
  }
}

export { formatSummary }

interface CaseOptions {
  timeoutMs: number
  retries: number
  onPricingMissing: (provider: string) => void
}

type CaseOutcome = { row: EvalRow; trace: EvalTraceTurn[] } | { failure: EvalFailure }

async function runCase(
  definition: AnyEvalDefinition,
  kase: EvalCase,
  rep: number,
  options: CaseOptions,
): Promise<CaseOutcome> {
  const startedAt = new Date()
  let attempt = 0
  let last: { failure: EvalFailureClass; message: string } = { failure: 'provider', message: 'never attempted' }

  while (attempt < options.retries + 1) {
    attempt += 1
    const began = Date.now()
    const controller = new AbortController()
    try {
      const result = await withTimeout(runAttempt(definition, kase, options, controller.signal), options, kase.id, controller)
      return {
        row: {
          ...result.row,
          rep,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - began,
        },
        trace: result.trace,
      }
    } catch (error) {
      if (error instanceof EvalRunError) throw error
      const failure = classify(error)
      last = { failure, message: describe(error) }
      // Only a provider error is worth a second call: a grader crash or a timeout would
      // reproduce, and re-running a timed-out case pays for the model twice.
      if (failure !== 'provider' || attempt > options.retries) break
      await backoff(attempt)
    }
  }

  return {
    failure: { caseId: kase.id, rep, failure: last.failure, message: last.message, attempts: attempt, at: startedAt.toISOString() },
  }
}

async function runAttempt(
  definition: AnyEvalDefinition,
  kase: EvalCase,
  options: CaseOptions,
  signal: AbortSignal,
): Promise<{ row: Omit<EvalRow, 'rep' | 'startedAt' | 'durationMs'>; trace: EvalTraceTurn[] }> {
  // A fresh app per case: the tools dispatch through the pipeline against it, so the
  // grader reads the end state its own tools wrote rather than the transcript.
  const app = (await definition.app()) as EvalAppHandle
  try {
    if (definition.setup) {
      try {
        await definition.setup(app, kase)
      } catch (error) {
        throw new CaseFailure('setup', error)
      }
    }

    const manager = resolveManager(app)
    const principal = definition.as ? await definition.as(app, kase) : null
    const bound = manager.agent(definition.agent).as(principal) as BoundAgent<Agent>
    const providerName = definition.provider ?? bound.agent.provider ?? manager.config.default
    const pricing = pricingOf(manager, providerName)
    if (!pricing) options.onPricingMissing(providerName)

    const judgeUsages: EvalUsage[] = []
    const judgeCosts: Array<number | undefined> = []
    const judge = async (input: string): Promise<AgentResponse<unknown>> => {
      if (!definition.judge) {
        throw new Error(
          'grade({ judge }) was called, and this eval configures none. Add judge: { agent: YourJudge, provider } '
          + 'to defineEval(), so the judge\'s usage and cost are recorded apart from the run\'s.',
        )
      }
      const judgeBound = manager.agent(definition.judge.agent).as(null)
      const response = await judgeBound.prompt(input, promptOptions(definition.judge.provider, signal))
      judgeUsages.push(toEvalUsage(response.usage))
      judgeCosts.push(computeCostUsd(toEvalUsage(response.usage), pricingOf(manager, definition.judge.provider ?? manager.config.default)))
      return response as AgentResponse<unknown>
    }

    const response = await bound.prompt(kase.input, promptOptions(definition.provider, signal))
    const model = response.steps.at(-1)?.model
    if (!model || response.steps.length === 0) {
      throw new EvalRunError(
        `${kase.id}: the response carried no model. Cost and the row's model come from the response, never from `
        + 'config, so a run cannot continue without it.',
      )
    }
    const usage = toEvalUsage(response.usage)
    if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
      throw new EvalRunError(`${kase.id}: the response carried no usage, so its cost cannot be derived.`)
    }
    const trace = buildTrace(bound.agent.instructions, kase.input, response)

    let scores: Record<string, number>
    try {
      scores = await definition.grade({ app, case: kase, expected: kase.expected, response, judge })
    } catch (error) {
      throw new CaseFailure('grade', error)
    }

    const judgeUsage = judgeUsages.reduce<EvalUsage>((total, one) => addUsage(total, one), {})
    return {
      row: {
        caseId: kase.id,
        status: response.finishReason === 'length' ? 'truncated' : 'ok',
        input: kase.input,
        text: response.text,
        output: response.output,
        scores,
        provider: providerName,
        model: model.modelId,
        modelProvider: model.provider,
        usage,
        ...maybe('costUsd', computeCostUsd(usage, pricing)),
        ...(judgeUsages.length > 0
          ? { judgeCalls: judgeUsages.length, judgeUsage, ...maybe('judgeCostUsd', sumCosts(judgeCosts)) }
          : {}),
        finishReason: response.finishReason,
        steps: response.steps.length,
        toolCalls: response.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
        tags: [...(kase.tags ?? [])],
      },
      trace,
    }
  } finally {
    // Neither may replace the failure that is already on its way out, or skip the other.
    if (definition.teardown) await settle(() => definition.teardown?.(app, kase), 'teardown', kase.id)
    await settle(() => dispose(app), 'disposal', kase.id)
  }
}

async function settle(work: () => unknown, what: string, caseId: string): Promise<void> {
  try {
    await work()
  } catch (error) {
    console.error(`[@guren/plugin-ai] ${what} failed for eval case "${caseId}".`, error)
  }
}

function promptOptions(provider: string | undefined, signal: AbortSignal): PromptOptions {
  return { signal, ...(provider ? ({ provider } as Pick<PromptOptions, 'provider'>) : {}) }
}

function resolveManager(app: EvalAppHandle): AiManager {
  if (!app.container?.has('ai')) {
    throw new EvalRunError(
      'The app this eval built binds no `ai` manager. defineEval({ app }) must return an object carrying the '
      + 'container of an application whose createApp({ config }) includes config/ai.ts.',
    )
  }
  return app.container.make<AiManager>('ai')
}

function pricingOf(manager: AiManager, provider: string): EvalPricing | undefined {
  const configured = manager.config.providers as Readonly<Record<string, AiProviderConfig | undefined>>
  return configured[provider]?.pricing
}

/**
 * The turn shape the harness's report builders read. The instructions lead it because they
 * are what a hill-climbing round is changing.
 */
function buildTrace(instructions: string, input: string, response: AgentResponse<unknown>): EvalTraceTurn[] {
  const trace: EvalTraceTurn[] = [
    { role: 'system', content: instructions },
    { role: 'user', content: input },
  ]
  for (const step of response.steps) {
    if (step.text !== '') trace.push({ role: 'assistant', content: step.text })
    for (const call of step.toolCalls) {
      trace.push({ role: 'assistant', content: stringify(call.input), name: call.toolName })
    }
    for (const result of step.toolResults) {
      trace.push({ role: 'tool', content: stringify((result as { output?: unknown }).output), name: result.toolName })
    }
  }
  return trace
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Carries the class a failure belongs to out of the place that knows it. */
class CaseFailure extends Error {
  constructor(readonly failure: EvalFailureClass, readonly cause: unknown) {
    super(describe(cause))
  }
}

function classify(error: unknown): EvalFailureClass {
  if (error instanceof CaseFailure) return error.failure
  if (error instanceof TimeoutError) return 'timeout'
  const name = error instanceof Error ? error.name : ''
  return name.includes('Tool') ? 'tool' : 'provider'
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

class TimeoutError extends Error {
  override name = 'EvalTimeoutError'
}

/**
 * The ceiling binds the work, not the wait: aborting is what stops the model call and
 * releases the app. Racing alone would leave a timed-out case billing in the background,
 * with its cost outside `--max-cost-usd` and its app alive under `--concurrency`.
 */
async function withTimeout<T>(work: Promise<T>, options: CaseOptions, caseId: string, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The race has already reported by the time the aborted work rejects.
  void work.catch(() => {})
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new TimeoutError(`${caseId} exceeded the ${options.timeoutMs}ms per-case ceiling.`))
        }, options.timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function backoff(attempt: number): Promise<void> {
  const ceiling = BACKOFF_BASE_MS * 2 ** (attempt - 1)
  await new Promise((settle) => setTimeout(settle, ceiling / 2 + Math.random() * (ceiling / 2)))
}

async function dispose(app: EvalAppHandle): Promise<void> {
  if (typeof app.close === 'function') {
    await app.close()
    return
  }
  const asyncDispose = (app as { [Symbol.asyncDispose]?: () => unknown })[Symbol.asyncDispose]
  if (typeof asyncDispose === 'function') await asyncDispose.call(app)
}

function maybe<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

function dryRunResult(context: {
  definition: AnyEvalDefinition
  flow: string
  variant: string
  reps: number
  selected: EvalCase[]
  startedAt: Date
  handle: EvalReporterHandle
}): EvalRunResult {
  const { definition, flow, variant, reps, selected, startedAt, handle } = context
  return {
    summary: {
      flow,
      variant,
      agentName: definition.agent.agentName ?? definition.agent.name,
      provider: definition.provider ?? '(the agent\'s own)',
      cases: selected.length,
      reps,
      rows: 0,
      truncated: 0,
      failures: 0,
      metrics: summarizeMetrics([], definition.metrics),
      usage: {},
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
    },
    rows: [],
    failures: [],
    ...maybe('location', handle.location),
    plannedCases: selected,
  }
}
