/**
 * The shapes an eval run produces (RFC 0029 §10). The runner owns isolation, the
 * real invocation and these records; where they land is a {@link EvalReporter}'s.
 */
import type { AgentClass, AgentPrincipalInput, AgentResponse, InferAgentOutput } from './agent'
import type { AiProviderName } from './types'

/** One case as `fromJsonl()` reads it: `{ id, input, expected?, seed?, tags? }`. */
export interface EvalCase<TExpected = unknown, TSeed = unknown> {
  id: string
  input: string
  expected?: TExpected
  /** Whatever `setup()` needs to build the world this case runs against. */
  seed?: TSeed
  /** `tags[0]` is what the split in `_state.json` stratifies on. */
  tags?: readonly string[]
}

/** Cases inline, or a function the runner calls once per run (`fromJsonl()` returns one). */
export type EvalCaseSource<TCase extends EvalCase> = readonly TCase[] | (() => TCase[] | Promise<TCase[]>)

export type EvalScores = Record<string, number>

/** `binary` gets the approximate half-width beside its mean; `score` is averaged and nothing more. */
export interface EvalMetric<TId extends string = string> {
  id: TId
  kind: 'binary' | 'score'
}

/** The container of the app a case runs in; the runner reaches `ai` through it and nothing else. */
export interface EvalContainer {
  has(key: string): boolean
  make<T>(key: string): T
}

/**
 * What `app()` returns. Anything carrying a container qualifies, so an app hands the
 * runner its `Application` (or a wrapper holding one beside a `TestApp`), and `setup()`
 * and `grade()` receive that same object back.
 */
export interface EvalAppHandle {
  readonly container: EvalContainer
  /** Called after each case, when present: the one disposal hook the runner calls. */
  close?(): unknown
}

export interface EvalUsage {
  inputTokens?: number
  noCacheInputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/**
 * `truncated` is `finishReason === 'length'`: plumbing, kept out of every metric mean and
 * counted beside it. A refusal is not a status — it is whatever `grade()` scores it.
 */
export type EvalRowStatus = 'ok' | 'truncated'

export interface EvalRow {
  caseId: string
  rep: number
  status: EvalRowStatus
  input: string
  text: string
  output: unknown
  scores: EvalScores
  /** The `config/ai.ts` provider the call was routed to, and the one its cost was priced under. */
  provider: string
  /** Both from the response, never from config: the model that answered, and who served it. */
  model: string
  modelProvider: string
  usage: EvalUsage
  /** Absent, never zero, when the provider configures no `pricing`. */
  costUsd?: number
  /** Judge usage is its own field, so a judge cannot dampen a difference between variants. */
  judgeCalls?: number
  judgeUsage?: EvalUsage
  /** The models that answered, from their responses: a judge that silently moved is otherwise invisible. */
  judgeModels?: string[]
  judgeCostUsd?: number
  finishReason: string
  steps: number
  toolCalls: string[]
  tags: string[]
  durationMs: number
  startedAt: string
}

/**
 * `tool` is the model and the SDK failing to complete a tool round-trip (a hallucinated name,
 * arguments the schema rejects). A tool that *throws* is not here: the pipeline hands the model
 * an `AppToolError` result (RFC 0029 §2.1), so the run finishes and the grader scores it.
 */
export type EvalFailureClass = 'setup' | 'provider' | 'tool' | 'grade' | 'timeout'

/** An attempt that produced nothing scorable. Counted beside the headline, never inside it. */
export interface EvalFailure {
  caseId: string
  rep: number
  failure: EvalFailureClass
  message: string
  /** How many times the case was attempted, retries included. */
  attempts: number
  at: string
}

/** One turn of a trace, in the `{ role, content, name? }` shape the harness's builders read. */
export interface EvalTraceTurn {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

export interface EvalRunContext {
  flow: string
  variant: string
  agentName: string
  provider: string
  reps: number
  /** Every case the eval declares, in file order, whether or not `--cases` selected it. */
  cases: ReadonlyArray<Pick<EvalCase, 'id' | 'tags'>>
  metrics: readonly EvalMetric[]
  startedAt: string
  /** Nothing may be written when set. */
  dryRun: boolean
}

export interface EvalMetricSummary {
  id: string
  kind: 'binary' | 'score'
  mean: number
  /** Rows that carried this metric, truncated ones excluded. */
  n: number
  /** `1/sqrt(n)` over those rows, for a binary metric only. */
  halfWidth?: number
}

export interface EvalSummary {
  flow: string
  variant: string
  agentName: string
  provider: string
  cases: number
  reps: number
  rows: number
  truncated: number
  failures: number
  metrics: EvalMetricSummary[]
  usage: EvalUsage
  costUsd?: number
  judgeCostUsd?: number
  costCapUsd?: number
  /** Set when the cap stopped the runner from starting cases it had left. */
  costCapReached?: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
}

/** Rows and failures as they settle; `begin()` hands back what a previous run already wrote. */
export interface EvalReporterHandle {
  /** Rows this (flow, variant) already holds. Resume skips them and the summary counts them. */
  readonly completed: readonly EvalRow[]
  /** Where results land, printed by `guren ai:eval`. */
  readonly location?: string
  row(row: EvalRow, trace: EvalTraceTurn[]): Promise<void> | void
  failure(failure: EvalFailure): Promise<void> | void
  end(summary: EvalSummary): Promise<void> | void
}

export interface EvalReporter {
  begin(context: EvalRunContext): Promise<EvalReporterHandle> | EvalReporterHandle
}

export interface EvalGradeContext<TApp extends EvalAppHandle, TCase extends EvalCase, TOutput> {
  app: TApp
  case: TCase
  /** `case.expected`, for the grader that reads nothing else off the case. */
  expected: TCase['expected']
  response: AgentResponse<TOutput>
  /**
   * Prompt the configured judge. Its usage and cost are recorded in the row's own judge
   * fields; without `judge` on the definition, calling it throws.
   */
  judge(input: string): Promise<AgentResponse<unknown>>
}

export interface EvalJudge {
  // oxlint-disable-next-line typescript/no-explicit-any -- any Agent subclass, whatever its scopes parameter
  agent: AgentClass<any>
  /** A `config/ai.ts` provider, so a judge runs on a different model from the one under test. */
  provider?: AiProviderName
}

export const EVAL_KIND = 'guren.eval' as const

/**
 * `defineEval()`'s result. Read duck-typed by {@link EVAL_KIND}, never by instance: the
 * eval file and `guren ai:eval` may import two copies of this package.
 */
export interface EvalDefinition<
  // oxlint-disable-next-line typescript/no-explicit-any -- the agent's scopes parameter is not part of this contract
  TAgent extends { instructions: string } = any,
  TApp extends EvalAppHandle = EvalAppHandle,
  TCase extends EvalCase = EvalCase,
  TScores extends EvalScores = EvalScores,
> {
  readonly kind: typeof EVAL_KIND
  /** Defaults to the eval file's basename when `guren ai:eval` loads one. */
  flow?: string
  // oxlint-disable-next-line typescript/no-explicit-any -- as above
  agent: AgentClass<any>
  app: () => TApp | Promise<TApp>
  cases: EvalCaseSource<TCase>
  /** Overrides the agent's own provider for every case, the judge excepted. */
  provider?: AiProviderName
  as?: (app: TApp, kase: TCase) => AgentPrincipalInput | Promise<AgentPrincipalInput>
  setup?: (app: TApp, kase: TCase) => unknown | Promise<unknown>
  teardown?: (app: TApp, kase: TCase) => unknown | Promise<unknown>
  grade: (context: EvalGradeContext<TApp, TCase, InferAgentOutput<TAgent>>) => TScores | Promise<TScores>
  metrics: ReadonlyArray<EvalMetric<Extract<keyof TScores, string>>>
  judge?: EvalJudge
  reporter?: EvalReporter
  /** Per-case wall clock, including `setup()` and `grade()`. 120000 when absent. */
  timeoutMs?: number
  /** Retries for a provider error, with jittered backoff. 2 when absent. */
  retries?: number
}
