/**
 * The eval runner (RFC 0029 §10). What the framework owns here is small on purpose:
 * isolation, the real invocation, and structured outcomes. Everything about the on-disk
 * layout belongs to a reporter.
 *
 * Evals are opt-in and never part of `guren check` or `guren gate`: every case calls the
 * model, and a nondeterministic gate is not one a PR should pay for.
 */
import {
  InvalidToolApprovalError,
  InvalidToolInputError,
  MissingToolResultsError,
  NoSuchToolError,
  ToolCallRepairError,
  ToolChoiceViolationError,
} from 'ai'

import { resolveAgentName } from './agent'
import type { Agent, AgentResponse, BoundAgent, PromptOptions } from './agent'
import type { AiProviderConfig } from './config'
import type { AiManager } from './manager'
import { addUsage, computeCostUsd, sumCosts, toEvalUsage } from './eval-cost'
import { hillclimbReporter } from './eval-reporter'
import { summarizeMetrics, totalCostUsd, totalJudgeCostUsd, totalUsage } from './eval-stats'
import type {
  EvalAppHandle,
  EvalCase,
  EvalDefinition,
  EvalFailure,
  EvalFailureClass,
  EvalRow,
  EvalSummary,
  EvalTraceTurn,
  EvalUsage,
} from './eval-types'
import type { AiPricing } from './types'

const DEFAULT_VARIANT = 'baseline'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRIES = 2
const BACKOFF_BASE_MS = 500

/**
 * What *this invocation* costs and where it lands. What a run *means* — the agent, the app,
 * the cases, the grader, the timeout and the retry budget — belongs on `defineEval()`, because
 * two runs of one eval under different ceilings are not comparable and must not differ by a flag.
 */
export interface RunEvalOptions {
  /** Overrides `defineEval({ flow })`; `guren ai:eval` passes the eval file's basename. */
  flow?: string
  /** Where the default reporter roots its output. The working directory when absent. */
  cwd?: string
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
  const retries = Math.max(0, definition.retries ?? DEFAULT_RETRIES)

  const all = typeof definition.cases === 'function' ? await definition.cases() : [...definition.cases]
  const selected = options.cases === undefined ? all : all.slice(0, options.cases)
  if (selected.length === 0) {
    throw new EvalRunError(`The eval "${flow}" resolved no cases; there is nothing to run.`)
  }
  // Checked for every source, not only `fromJsonl()`: two cases sharing an id write one trace,
  // count as two samples, and are both skipped by the next resume.
  const repeated = all.map((kase) => kase.id).filter((id, index, ids) => ids.indexOf(id) !== index)
  if (repeated.length > 0) {
    throw new EvalRunError(`The eval "${flow}" repeats the case id(s) ${[...new Set(repeated)].join(', ')}; each must be unique.`)
  }

  const startedAt = new Date().toISOString()
  const agentName = resolveAgentName(definition.agent)
  const provider = definition.provider ?? '(the agent\'s own)'
  const reporter = definition.reporter
    ?? hillclimbReporter({ ...maybe('cwd', options.cwd), onWarning: options.onWarning })
  // Opened before the first app, so a dry run reports its target directory without booting one.
  const handle = await reporter.begin({
    flow,
    variant,
    agentName,
    provider,
    reps,
    // Every case, not the `--cases` selection: `_state.json` is written once and describes
    // the case set, so a first run capped at two must not fix the split at two ids forever.
    cases: all.map((kase) => ({ id: kase.id, tags: kase.tags })),
    metrics: definition.metrics,
    startedAt,
    dryRun: Boolean(options.dryRun),
  })

  const done = new Set(handle.completed.map((row) => `${row.caseId}#${row.rep}`))
  const rows: EvalRow[] = []
  const failures: EvalFailure[] = []
  // A dry run plans nothing, so it spawns no worker and falls through the ordinary summary
  // rather than assembling a second copy of it that drifts.
  const queue: Array<{ kase: EvalCase; rep: number }> = []
  for (let rep = 1; !options.dryRun && rep <= reps; rep += 1) {
    for (const kase of selected) {
      if (!done.has(`${kase.id}#${rep}`)) queue.push({ kase, rep })
    }
  }

  let spentUsd = 0
  let capReached = false
  let pricingWarned = false
  let next = 0
  let stopped = false

  const worker = async (): Promise<void> => {
    for (;;) {
      // A runner failure in one worker stops the others: rows appended after the summary
      // was written would leave summary.json describing fewer rows than results.jsonl holds.
      if (stopped) return
      // A cap is a *soft* ceiling: this stops new cases only, and cases in flight complete.
      if (options.maxCostUsd !== undefined && spentUsd >= options.maxCostUsd) {
        if (next < queue.length) capReached = true
        return
      }
      const item = queue[next++]
      if (!item) return

      let outcome: Awaited<ReturnType<typeof runCase>>
      try {
        outcome = await runCase(definition, item.kase, item.rep, { timeoutMs, retries, onPricingMissing })
      } catch (error) {
        stopped = true
        throw error
      }

      if ('row' in outcome) {
        spentUsd += (outcome.row.costUsd ?? 0) + (outcome.row.judgeCostUsd ?? 0)
        rows.push(outcome.row)
        await handle.row(outcome.row, outcome.trace)
      } else {
        // A model call the grader then threw over is money spent: without this the ceiling
        // never moves while a broken grader runs the whole case set.
        spentUsd += outcome.failure.costUsd ?? 0
        failures.push(outcome.failure)
        await handle.failure(outcome.failure)
      }
    }
  }

  function onPricingMissing(missing: string): void {
    if (pricingWarned || options.maxCostUsd === undefined) return
    pricingWarned = true
    options.onWarning?.(
      `The provider "${missing}" configures no \`pricing\` in config/ai.ts, so no cost is derived `
      + `and --max-cost-usd ${options.maxCostUsd} cannot stop this run.`,
    )
  }

  const allRows = (): EvalRow[] => [...handle.completed, ...rows]

  const buildSummary = (): EvalSummary => {
    const finishedAt = new Date()
    const scored = allRows()
    return {
      flow,
      variant,
      agentName,
      provider,
      // The rows include what a resume skipped, so the case count must too, or the headline
      // reads "1 cases x 1 reps = 3 rows" after a `--cases 1` re-run.
      cases: new Set([...selected.map((kase) => kase.id), ...scored.map((row) => row.caseId)]).size,
      reps,
      rows: scored.length,
      truncated: scored.filter((row) => row.status === 'truncated').length,
      failures: failures.length,
      metrics: summarizeMetrics(scored, definition.metrics),
      usage: totalUsage(scored),
      ...maybe('costUsd', totalCostUsd(scored)),
      ...maybe('judgeCostUsd', totalJudgeCostUsd(scored)),
      ...maybe('costCapUsd', options.maxCostUsd),
      ...maybe('costCapReached', capReached || undefined),
      startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - Date.parse(startedAt),
    }
  }

  // `allSettled`, not `all`: a rejection would otherwise resume here while a sibling worker is
  // still mid-case, and that case's row lands after summary.json has already been written.
  // Built once, too — a second call would time itself again and the printed duration would
  // differ from the one on disk.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  const summary = buildSummary()
  await handle.end(summary)
  const broke = settled.find((result) => result.status === 'rejected')
  if (broke) throw broke.reason

  return { summary, rows: allRows(), failures, ...maybe('location', handle.location), plannedCases: selected }
}

interface CaseOptions {
  timeoutMs: number
  retries: number
  onPricingMissing: PricingWarning
}

/** Told the provider whose `pricing` is missing, once per run. */
type PricingWarning = (provider: string) => void

const RETRYABLE = new Set<EvalFailureClass>(['provider', 'tool'])

type CaseOutcome = { row: EvalRow; trace: EvalTraceTurn[] } | { failure: EvalFailure }

async function runCase(
  definition: AnyEvalDefinition,
  kase: EvalCase,
  rep: number,
  options: CaseOptions,
): Promise<CaseOutcome> {
  const startedAt = new Date().toISOString()

  for (let tries = 1; ; tries += 1) {
    const controller = new AbortController()
    try {
      const result = await withTimeout(runAttempt(definition, kase, options.onPricingMissing, controller.signal), options.timeoutMs, kase.id, controller)
      // From the case's own start, so a retry's backoff is inside the number rather than
      // dropped: `startedAt` plus `durationMs` is when the row settled.
      return { row: { ...result.row, rep, startedAt, durationMs: Date.now() - Date.parse(startedAt) }, trace: result.trace }
    } catch (error) {
      if (error instanceof EvalRunError) throw error
      const failure = classify(error)
      // A grader crash, a bad setup and the ceiling all reproduce; re-running a timed-out
      // case pays for the model twice. Only the model's own faults are worth a second call.
      if (!RETRYABLE.has(failure) || tries > options.retries) {
        const spent = error instanceof CaseFailure ? error.costUsd : undefined
        return {
          failure: {
            caseId: kase.id,
            rep,
            failure,
            message: describe(error),
            attempts: tries,
            at: startedAt,
            ...maybe('costUsd', spent),
          },
        }
      }
      await backoff(tries)
    }
  }
}

async function runAttempt(
  definition: AnyEvalDefinition,
  kase: EvalCase,
  onPricingMissing: PricingWarning,
  signal: AbortSignal,
): Promise<{ row: Omit<EvalRow, 'rep' | 'startedAt' | 'durationMs'>; trace: EvalTraceTurn[] }> {
  // A fresh app per case: the tools dispatch through the pipeline against it, so the
  // grader reads the end state its own tools wrote rather than the transcript.
  // Building the app is setup, not a model call: an app that cannot boot reproduces, so
  // classifying it `provider` would retry every case against a configuration error.
  const app = await attempt('setup', () => definition.app() as Promise<EvalAppHandle>)
  try {
    if (definition.setup) await attempt('setup', () => definition.setup?.(app, kase, signal))

    const manager = resolveManager(app)
    const principal = definition.as ? await definition.as(app, kase) : null
    const bound = manager.agent(definition.agent).as(principal) as BoundAgent<Agent>
    const providerName = definition.provider ?? bound.agent.provider ?? manager.config.default
    const pricing = pricingOf(manager, providerName)
    if (!pricing) onPricingMissing(providerName)

    const judgeBound = definition.judge ? manager.agent(definition.judge.agent).as(null) : undefined
    // Resolved the way the agent's is, class provider included: reading only
    // `judge.provider ?? default` prices a judge that names its own provider at another's rate.
    const judgePricing = judgeBound && definition.judge
      ? pricingOf(manager, definition.judge.provider ?? judgeBound.agent.provider ?? manager.config.default)
      : undefined
    const judged: Array<{ usage: EvalUsage; model?: string; cost?: number }> = []
    const judge = async (input: string): Promise<AgentResponse<unknown>> => {
      if (!judgeBound || !definition.judge) {
        throw new Error(
          'grade({ judge }) was called, and this eval configures none. Add judge: { agent: YourJudge, provider } '
          + 'to defineEval(), so the judge\'s usage and cost are recorded apart from the run\'s.',
        )
      }
      const response = await judgeBound.prompt(input, promptOptions(definition.judge.provider, signal))
      const usage = toEvalUsage(response.usage)
      // The judge's model is recorded for the same reason the agent's is: a round where it
      // silently resolved to a different one is otherwise invisible in the written data.
      judged.push({
        usage,
        ...maybe('model', response.steps.at(-1)?.model.modelId),
        ...maybe('cost', computeCostUsd(usage, judgePricing)),
      })
      return response as AgentResponse<unknown>
    }

    const response = await bound.prompt(kase.input, promptOptions(definition.provider, signal))
    const model = response.steps.at(-1)?.model
    if (!model) {
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

    const costUsd = computeCostUsd(usage, pricing)
    let scores: Record<string, number>
    try {
      scores = await definition.grade({ app, case: kase, expected: kase.expected, response, judge, signal })
    } catch (error) {
      // `judged` fills during grade(), so the judge's share is only known here.
      throw new CaseFailure('grade', error, sumCosts([costUsd, ...judged.map((one) => one.cost)]))
    }
    const judgeCostUsd = sumCosts(judged.map((one) => one.cost))

    const judgeTotal = judged.reduce<EvalUsage>((total, one) => addUsage(total, one.usage), {})
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
        ...maybe('costUsd', costUsd),
        ...(judged.length > 0
          ? {
              judgeCalls: judged.length,
              judgeUsage: judgeTotal,
              ...maybe('judgeModels', [...new Set(judged.flatMap((one) => one.model ?? []))]),
              ...maybe('judgeCostUsd', judgeCostUsd),
            }
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

function pricingOf(manager: AiManager, provider: string): AiPricing | undefined {
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
    // `toolResults` holds successes only; without this a case whose every tool call failed
    // writes calls with no outcomes, and the reader blames the prompt.
    for (const part of step.content) {
      if (part.type === 'tool-error') {
        trace.push({ role: 'tool', content: `error: ${describe(part.error)}`, name: part.toolName })
      }
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

/** Run `work`, tagging whatever it throws with the failure class this step belongs to. */
async function attempt<T>(failure: EvalFailureClass, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw new CaseFailure(failure, error)
  }
}

/** Carries the class a failure belongs to out of the place that knows it. */
class CaseFailure extends Error {
  constructor(readonly failure: EvalFailureClass, readonly cause: unknown, readonly costUsd?: number) {
    super(describe(cause))
  }
}

/**
 * By the SDK's own marker guards, not by the error's name: `AI_NoSuchToolError` contains
 * "Tool" but is the *model* naming a tool that does not exist, which a second call often
 * fixes. `isInstance` rather than `instanceof`, because two copies of `ai` may be loaded.
 */
const TOOL_PROTOCOL_ERRORS = [
  NoSuchToolError,
  InvalidToolInputError,
  ToolCallRepairError,
  ToolChoiceViolationError,
  MissingToolResultsError,
  InvalidToolApprovalError,
] as const

function classify(error: unknown): EvalFailureClass {
  if (error instanceof CaseFailure) return error.failure
  if (error instanceof TimeoutError) return 'timeout'
  return TOOL_PROTOCOL_ERRORS.some((kind) => kind.isInstance(error)) ? 'tool' : 'provider'
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
async function withTimeout<T>(work: Promise<T>, timeoutMs: number, caseId: string, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The race has already reported by the time the aborted work rejects.
  void work.catch(() => {})
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new TimeoutError(`${caseId} exceeded the ${timeoutMs}ms per-case ceiling.`))
        }, timeoutMs)
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
  if (typeof app.close === 'function') await app.close()
}

function maybe<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}
