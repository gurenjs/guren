process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createApp, type Application } from '@guren/core'
import { NoSuchToolError } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

import { z } from 'zod'

import { Agent, aiPlugin, defineAiConfig, tool } from '../src'
import {
  defineEval,
  fromJsonl,
  hillclimbReporter,
  parseJsonlCases,
  runEval,
  type EvalCase,
  type EvalReporter,
  type EvalRow,
  type EvalTraceTurn,
} from '../src/eval'
// Arithmetic internals, deliberately not on the published surface.
import { computeCostUsd } from '../src/eval-cost'
import { summarizeMetrics } from '../src/eval-stats'
import { scriptedModel, type ScriptedStep } from './fixture'

const PRICING = { input: 3, output: 15 }

class Triager extends Agent {
  static override agentName = 'triager'
  instructions = 'Triage the ticket.'
}

class Judge extends Agent {
  static override agentName = 'judge'
  instructions = 'Score the answer.'
  override provider = 'judge'
}

class ToolUser extends Agent<typeof ToolUser.scopes> {
  static override agentName = 'tool-user'
  static override scopes = ['tool:posts_index'] as const
  instructions = 'Read the posts.'

  override tools() {
    return this.appTools(['posts_index'])
  }
}

/** A tool that throws reaches the model as an error part, never as a thrown eval failure. */
class ToolThrower extends Agent {
  static override agentName = 'tool-thrower'
  instructions = 'Call the tool.'

  override tools() {
    return {
      boom: tool({
        description: 'throws',
        inputSchema: z.object({}),
        execute: async (): Promise<string> => { throw new Error('the tool blew up') },
      }),
    }
  }
}

interface EvalHarness {
  app: Application
  container: Application['container']
}

async function bootEvalApp(options: {
  model: MockLanguageModelV4
  judgeModel?: MockLanguageModelV4
  pricing?: { input: number; output: number; cacheRead?: number }
} = { model: scriptedModel([{ text: 'ok' }]) }): Promise<EvalHarness> {
  const app = createApp({
    routes: (router) => {
      router
        .get('/posts', () => Response.json({ posts: [{ id: 1 }] }))
        .name('posts_index')
        .agent({ description: 'List posts' })
    },
    config: [
      defineAiConfig(() => ({
        default: 'main',
        providers: {
          main: { model: () => options.model, ...(options.pricing ? { pricing: options.pricing } : {}) },
          judge: { model: () => options.judgeModel ?? options.model, pricing: { input: 1, output: 1 } },
        },
      })),
    ],
    providers: [aiPlugin()],
  })
  await app.boot()
  return { app, container: app.container }
}

function cases(...ids: string[]): EvalCase[] {
  return ids.map((id) => ({ id, input: `prompt ${id}`, expected: { answer: 'yes' }, tags: ['billing'] }))
}

/** A reporter that keeps everything in memory, so a test asserts the runner and not the disk. */
interface MemoryReporter extends EvalReporter {
  rows: EvalRow[]
  traces: EvalTraceTurn[][]
  failures: Array<{ message: string }>
}

function memoryReporter(completed: EvalRow[] = []): MemoryReporter {
  const rows: EvalRow[] = []
  const traces: EvalTraceTurn[][] = []
  const failures: Array<{ message: string }> = []
  return {
    rows,
    traces,
    failures,
    begin: () => ({
      completed,
      location: '(memory)',
      row: (row, trace) => { rows.push(row); traces.push(trace) },
      failure: (failure) => { failures.push(failure) },
      end: () => {},
    }),
  }
}

function answering(steps: ScriptedStep[]): MockLanguageModelV4 {
  return scriptedModel(steps)
}

/** Always answers, but stops for length: the plumbing status, not a model result. */
function truncatingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'half an ans' }],
      finishReason: { unified: 'length' as const, raw: undefined },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } },
      warnings: [],
    }),
  })
}

const temporaries: string[] = []
afterEach(() => {
  for (const directory of temporaries.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function scratch(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'guren-eval-'))
  temporaries.push(directory)
  return directory
}

describe('runEval', () => {
  test('should run each case in its own app and record model, usage, cost and scores', async () => {
    const built: Application[] = []
    const reporter = memoryReporter()
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: async () => {
          const harness = await bootEvalApp({ model: answering([{ text: 'billing' }]), pricing: PRICING })
          built.push(harness.app)
          return harness
        },
        cases: cases('a', 'b'),
        grade: ({ response }) => ({ category: response.text === 'billing' ? 1 : 0 }),
        metrics: [{ id: 'category', kind: 'binary' }],
        reporter,
      }),
    )

    expect(built).toHaveLength(2)
    expect(result.rows.map((row) => row.caseId)).toEqual(['a', 'b'])
    expect(result.rows[0]!.model).toBe('mock-model-id')
    expect(result.rows[0]!.modelProvider).toBe('mock-provider')
    // The config provider is what the cost was priced under, so the row names both.
    expect(result.rows[0]!.provider).toBe('main')
    expect(result.rows[0]!.status).toBe('ok')
    expect(result.rows[0]!.scores).toEqual({ category: 1 })
    expect(result.rows[0]!.usage.inputTokens).toBe(3)
    expect(result.rows[0]!.costUsd).toBeCloseTo((3 * 3 + 2 * 15) / 1_000_000, 12)
    expect(result.summary.metrics[0]).toMatchObject({ id: 'category', mean: 1, n: 2 })
    expect(result.summary.metrics[0]!.halfWidth).toBeCloseTo(1 / Math.sqrt(2), 12)
  })

  test('should leave costUsd absent, never zero, for a provider that configures no pricing', async () => {
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]) }),
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
    )

    expect(Object.hasOwn(result.rows[0]!, 'costUsd')).toBe(false)
    expect(result.summary.costUsd).toBeUndefined()
  })

  test('should warn that a cost ceiling cannot be evaluated without pricing', async () => {
    const warnings: string[] = []
    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]) }),
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
      { maxCostUsd: 5, onWarning: (message) => warnings.push(message) },
    )

    expect(warnings.join('\n')).toContain('--max-cost-usd 5')
  })

  test('should keep a truncated row out of the mean and count it beside it', async () => {
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: truncatingModel(), pricing: PRICING }),
        cases: cases('a'),
        grade: () => ({ category: 1 }),
        metrics: [{ id: 'category', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
    )

    expect(result.rows[0]!.status).toBe('truncated')
    expect(result.summary.truncated).toBe(1)
    expect(result.summary.metrics[0]).toMatchObject({ n: 0, mean: 0 })
    expect(result.summary.metrics[0]!.halfWidth).toBeUndefined()
  })

  test('should stop starting cases once the derived cost crosses the ceiling', async () => {
    const reporter = memoryReporter()
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: { input: 1_000_000, output: 1_000_000 } }),
        cases: cases('a', 'b', 'c'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
      { maxCostUsd: 1 },
    )

    expect(result.rows).toHaveLength(1)
    expect(result.summary.costCapReached).toBe(true)
    expect(result.summary.costCapUsd).toBe(1)
  })

  test('should send a grader crash to the sidecar without retrying it', async () => {
    let graded = 0
    const reporter = memoryReporter()
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a'),
        grade: (): { ok: number } => {
          graded += 1
          throw new Error('the grader read a column that is not there')
        },
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
    )

    expect(graded).toBe(1)
    expect(result.rows).toHaveLength(0)
    expect(result.failures[0]).toMatchObject({ caseId: 'a', failure: 'grade', attempts: 1 })
    expect(result.failures[0]!.message).toContain('not there')
    expect(result.summary.failures).toBe(1)
  })

  test('should retry a provider error and record the attempt count on the sidecar row', async () => {
    let calls = 0
    const flaky = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1
        throw new Error('upstream said 503')
      },
    })
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: flaky, pricing: PRICING }),
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        retries: 1,
        reporter: memoryReporter(),
      }),
    )

    expect(result.failures[0]).toMatchObject({ failure: 'provider', attempts: 2 })
    // The SDK retries a *retryable* error itself; a plain one reaches the runner each time.
    expect(calls).toBe(2)
  })

  test('should fail the whole run, not the row, when a response carries no usage', async () => {
    const usageless = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'x' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    })

    await expect(
      runEval(
        defineEval({
          flow: 'triage',
          agent: Triager,
          app: () => bootEvalApp({ model: usageless, pricing: PRICING }),
          cases: cases('a'),
          grade: () => ({ ok: 1 }),
          metrics: [{ id: 'ok', kind: 'binary' }],
          reporter: memoryReporter(),
        }),
      ),
    ).rejects.toThrow('carried no usage')
  })

  test('should skip a (case, rep) the reporter already holds and summarize over both', async () => {
    const earlier: EvalRow = {
      caseId: 'a',
      rep: 1,
      status: 'ok',
      input: 'prompt a',
      text: 'x',
      output: 'x',
      scores: { ok: 0 },
      provider: 'main',
      model: 'mock-model-id',
      modelProvider: 'mock-provider',
      usage: { inputTokens: 3, outputTokens: 2 },
      finishReason: 'stop',
      steps: 1,
      toolCalls: [],
      tags: [],
      durationMs: 1,
      startedAt: new Date().toISOString(),
    }
    const reporter = memoryReporter([earlier])
    let prompts = 0
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: async () => {
          prompts += 1
          return bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING })
        },
        cases: cases('a', 'b'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
    )

    expect(prompts).toBe(1)
    expect(reporter.rows.map((row) => row.caseId)).toEqual(['b'])
    expect(result.summary.rows).toBe(2)
    expect(result.summary.metrics[0]).toMatchObject({ n: 2, mean: 0.5 })
  })

  test('should repeat each case --reps times, keyed so a resume is idempotent', async () => {
    const reporter = memoryReporter()
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a', 'b'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
      { reps: 2 },
    )

    expect(reporter.rows.map((row) => `${row.caseId}#${row.rep}`).sort()).toEqual(['a#1', 'a#2', 'b#1', 'b#2'])
    expect(result.summary.metrics[0]!.halfWidth).toBeCloseTo(1 / Math.sqrt(4), 12)
  })

  test('should record the judge\'s usage and cost in their own fields', async () => {
    const reporter = memoryReporter()
    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({
          model: answering([{ text: 'answer' }]),
          judgeModel: answering([{ text: '1' }]),
          pricing: PRICING,
        }),
        cases: cases('a'),
        judge: { agent: Judge, provider: 'judge' },
        grade: async ({ judge, response }) => ({ rubric: (await judge(`Grade: ${response.text}`)).text === '1' ? 1 : 0 }),
        metrics: [{ id: 'rubric', kind: 'binary' }],
        reporter,
      }),
    )

    const row = reporter.rows[0]!
    expect(row.scores).toEqual({ rubric: 1 })
    expect(row.judgeCalls).toBe(1)
    expect(row.judgeCostUsd).toBeCloseTo((3 * 1 + 2 * 1) / 1_000_000, 12)
    // The row's own cost stays the model's, so a judge cannot dampen a difference.
    expect(row.costUsd).toBeCloseTo((3 * 3 + 2 * 15) / 1_000_000, 12)
  })

  test('should record which model answered as the judge', async () => {
    const reporter = memoryReporter()
    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({
          model: answering([{ text: 'answer' }]),
          judgeModel: answering([{ text: '1' }]),
          pricing: PRICING,
        }),
        cases: cases('a'),
        judge: { agent: Judge, provider: 'judge' },
        grade: async ({ judge }) => ({ ok: (await judge('x')).text === '1' ? 1 : 0 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
    )

    expect(reporter.rows[0]!.judgeModels).toEqual(['mock-model-id'])
  })

  test('should refuse a grade() that asks for a judge the eval does not configure', async () => {
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a'),
        grade: async ({ judge }) => ({ ok: (await judge('x')) ? 1 : 0 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
    )

    expect(result.failures[0]!.message).toContain('configures none')
  })

  test('should run the app\'s own tools for real and put them in the trace', async () => {
    const reporter = memoryReporter()
    await runEval(
      defineEval({
        flow: 'tools',
        agent: ToolUser,
        app: () => bootEvalApp({
          model: answering([{ toolCalls: [{ name: 'posts_index', input: {} }] }, { text: 'one post' }]),
          pricing: PRICING,
        }),
        cases: cases('a'),
        grade: ({ response }) => ({ ok: response.text === 'one post' ? 1 : 0 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
    )

    const row = reporter.rows[0]!
    expect(row.toolCalls).toEqual(['posts_index'])
    expect(row.scores).toEqual({ ok: 1 })
    const trace = reporter.traces[0]!
    expect(trace[0]).toEqual({ role: 'system', content: 'Read the posts.' })
    expect(trace[1]).toEqual({ role: 'user', content: 'prompt a' })
    expect(trace.find((turn) => turn.role === 'tool')?.name).toBe('posts_index')
    expect(trace.find((turn) => turn.role === 'tool')?.content).toContain('"posts"')
  })

  test('should retry a tool-protocol fault, which is the model\'s and not the tool\'s', async () => {
    let calls = 0
    const hallucinating = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1
        throw new NoSuchToolError({ toolName: 'nope', availableTools: ['posts_index'] })
      },
    })

    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: hallucinating, pricing: PRICING }),
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        retries: 1,
        reporter: memoryReporter(),
      }),
    )

    // Its name is `AI_NoSuchToolError`; classifying on that substring denied it the retry.
    expect(result.failures[0]).toMatchObject({ failure: 'tool', attempts: 2 })
    expect(calls).toBe(2)
  })

  test('should put a tool call that failed into the trace, not only the ones that returned', async () => {
    const reporter = memoryReporter()
    await runEval(
      defineEval({
        flow: 'tools',
        agent: ToolThrower,
        app: () => bootEvalApp({
          model: answering([{ toolCalls: [{ name: 'boom', input: {} }] }, { text: 'gave up' }]),
          pricing: PRICING,
        }),
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
    )

    const trace = reporter.traces[0]!
    const outcome = trace.find((turn) => turn.role === 'tool')
    expect(outcome?.content).toContain('error:')
  })

  test('should run only the first --cases in file order', async () => {
    const reporter = memoryReporter()
    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a', 'b', 'c'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
      { cases: 2 },
    )

    expect(reporter.rows.map((row) => row.caseId)).toEqual(['a', 'b'])
  })

  test('should abort the model call when a case passes the per-case ceiling, and release its app', async () => {
    let aborted = false
    let closed = 0
    const hanging = new MockLanguageModelV4({
      doGenerate: async (options) => new Promise<never>((_, reject) => {
        options.abortSignal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted by the caller'))
        })
      }),
    })

    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: async () => {
          const harness = await bootEvalApp({ model: hanging, pricing: PRICING })
          return { ...harness, close: () => { closed += 1 } }
        },
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        timeoutMs: 50,
        retries: 0,
        reporter: memoryReporter(),
      }),
    )

    expect(result.failures[0]).toMatchObject({ caseId: 'a', failure: 'timeout', attempts: 1 })
    // Racing alone would leave the call billing in the background with its app alive.
    await Bun.sleep(20)
    expect(aborted).toBe(true)
    expect(closed).toBe(1)
  })

  test('should keep the failure a grader raised when teardown throws on the way out', async () => {
    let closed = 0
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: async () => {
          const harness = await bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING })
          return { ...harness, close: () => { closed += 1 } }
        },
        cases: cases('a'),
        grade: (): { ok: number } => { throw new Error('the grader read a column that is not there') },
        teardown: () => { throw new Error('teardown blew up too') },
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
    )

    expect(result.failures[0]).toMatchObject({ failure: 'grade' })
    expect(result.failures[0]!.message).toContain('not there')
    expect(closed).toBe(1)
  })

  test('should run every case with more than one in flight', async () => {
    const reporter = memoryReporter()
    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a', 'b', 'c', 'd'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter,
      }),
      { concurrency: 2 },
    )

    expect(reporter.rows.map((row) => row.caseId).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('should record a subclass under its own name, not a parent\'s pinned agentName', async () => {
    class Inherits extends Triager {}

    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Inherits,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
    )

    // Statics are inherited: reading `agent.agentName` would name Triager for every subclass.
    expect(result.summary.agentName).toBe('Inherits')
  })

  test('should keep the judge out of the summary\'s own cost, as the rows do', async () => {
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({
          model: answering([{ text: 'answer' }]),
          judgeModel: answering([{ text: '1' }]),
          pricing: PRICING,
        }),
        cases: cases('a'),
        judge: { agent: Judge, provider: 'judge' },
        grade: async ({ judge }) => ({ ok: (await judge('x')).text === '1' ? 1 : 0 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
    )

    // summary.usage covers the model alone, so summary.costUsd must as well.
    expect(result.summary.costUsd).toBe(result.rows[0]!.costUsd!)
    expect(result.summary.judgeCostUsd).toBe(result.rows[0]!.judgeCostUsd!)
  })

  test('should treat an app that cannot be built as setup, attempted once', async () => {
    let built = 0
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: (): Promise<EvalHarness> => {
          built += 1
          throw new Error('DATABASE_URL is not set')
        },
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
    )

    // Retrying it would pay backoff on every case for one configuration error.
    expect(built).toBe(1)
    expect(result.failures[0]).toMatchObject({ failure: 'setup', attempts: 1 })
    expect(result.failures[0]!.message).toContain('DATABASE_URL')
  })

  test('should let every worker settle before the summary is written', async () => {
    const order: string[] = []
    let built = 0
    const usageless = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'x' }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: {
          inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: undefined, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    })

    await expect(
      runEval(
        defineEval({
          flow: 'triage',
          agent: Triager,
          // The first case stops the run; the second is already in flight and must land first.
          app: () => bootEvalApp({ model: built++ === 0 ? usageless : answering([{ text: 'x' }]), pricing: PRICING }),
          cases: cases('a', 'b'),
          grade: () => ({ ok: 1 }),
          metrics: [{ id: 'ok', kind: 'binary' }],
          reporter: {
            begin: () => ({
              completed: [],
              row: (row) => { order.push(`row:${row.caseId}`) },
              failure: () => {},
              end: () => { order.push('end') },
            }),
          },
        }),
        { concurrency: 2 },
      ),
    ).rejects.toThrow('carried no usage')

    // A row appended after `end` leaves summary.json describing fewer rows than exist.
    expect(order.at(-1)).toBe('end')
  })

  test('should charge a case whose grader threw against the cost ceiling', async () => {
    let graded = 0
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: { input: 1_000_000, output: 1_000_000 } }),
        cases: cases('a', 'b', 'c'),
        grade: (): { ok: number } => {
          graded += 1
          throw new Error('the grader is broken')
        },
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
      { maxCostUsd: 1 },
    )

    // The model was paid for each of those calls; without counting them the ceiling never moves.
    expect(graded).toBe(1)
    expect(result.failures[0]!.costUsd).toBeGreaterThan(0)
    expect(result.summary.costCapReached).toBe(true)
  })

  test('should time a retried case from its own start, backoff included', async () => {
    let calls = 0
    const flaky = new MockLanguageModelV4({
      doGenerate: async () => {
        calls += 1
        if (calls === 1) throw new Error('upstream said 503')
        return {
          content: [{ type: 'text' as const, text: 'x' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 2, text: 2, reasoning: 0 },
          },
          warnings: [],
        }
      },
    })

    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: flaky, pricing: PRICING }),
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        retries: 1,
        reporter: memoryReporter(),
      }),
    )

    // Timing only the winning attempt drops the backoff, so startedAt + durationMs lies.
    expect(result.rows[0]!.durationMs).toBeGreaterThanOrEqual(250)
  })

  test('should refuse a case set that repeats an id, whatever the source', async () => {
    await expect(
      runEval(
        defineEval({
          flow: 'triage',
          agent: Triager,
          app: () => bootEvalApp({ model: answering([{ text: 'x' }]) }),
          cases: [{ id: 'a', input: 'one' }, { id: 'a', input: 'two' }],
          grade: () => ({ ok: 1 }),
          metrics: [{ id: 'ok', kind: 'binary' }],
          reporter: memoryReporter(),
        }),
      ),
    ).rejects.toThrow('repeats the case id(s) a')
  })

  test('should call no model and write nothing on --dry-run', async () => {
    let built = 0
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: async () => {
          built += 1
          return bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING })
        },
        cases: cases('a', 'b'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      }),
      { dryRun: true },
    )

    expect(built).toBe(0)
    expect(result.rows).toHaveLength(0)
    expect(result.plannedCases.map((kase) => kase.id)).toEqual(['a', 'b'])
  })

  test('should refuse an eval with no flow name and one that resolves no cases', async () => {
    const define = (flow: string | undefined, kases: EvalCase[]) =>
      defineEval({
        ...(flow ? { flow } : {}),
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]) }),
        cases: kases,
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: memoryReporter(),
      })

    await expect(runEval(define(undefined, cases('a')))).rejects.toThrow('no flow name')
    await expect(runEval(define('triage', []))).rejects.toThrow('resolved no cases')
  })
})

describe('defineEval', () => {
  test('should refuse empty and duplicated metrics', () => {
    const base = {
      agent: Triager,
      app: () => bootEvalApp({ model: answering([{ text: 'x' }]) }),
      cases: cases('a'),
      grade: () => ({ ok: 1 }),
    }

    expect(() => defineEval({ ...base, metrics: [] })).toThrow('is empty')
    expect(() => defineEval({ ...base, metrics: [{ id: 'ok', kind: 'binary' }, { id: 'ok', kind: 'score' }] }))
      .toThrow('declares "ok" twice')
  })

  test('should constrain metric ids to the scores grade() returns', () => {
    defineEval({
      agent: Triager,
      app: () => bootEvalApp({ model: answering([{ text: 'x' }]) }),
      cases: cases('a'),
      grade: () => ({ category: 1, prioritySet: 0 }),
      // @ts-expect-error a metric grade() never scores is a compile error (RFC 0029 §11)
      metrics: [{ id: 'categorie', kind: 'binary' }],
    })
  })
})

describe('fromJsonl', () => {
  test('should read one case per line and keep file order', async () => {
    const directory = scratch()
    const path = resolve(directory, 'cases.jsonl')
    await Bun.write(path, '{"id":"a","input":"one","tags":["billing"]}\n\n{"id":"b","input":"two"}\n')
    expect(fromJsonl(path)()).toEqual([
      { id: 'a', input: 'one', tags: ['billing'] },
      { id: 'b', input: 'two' },
    ])
  })

  test('should name the line for a malformed case, a missing id or input, and a repeated id', () => {
    expect(() => parseJsonlCases('{', 'cases.jsonl')).toThrow('cases.jsonl:1 is not valid JSON')
    expect(() => parseJsonlCases('{"input":"x"}', 'cases.jsonl')).toThrow('has no string `id`')
    expect(() => parseJsonlCases('{"id":"a"}', 'cases.jsonl')).toThrow('has no string `input`')
    expect(() => parseJsonlCases('{"id":"a","input":"x"}\n{"id":"a","input":"y"}', 'cases.jsonl'))
      .toThrow('repeats the case id "a"')
  })

  test('should read the file when the run starts, not when the eval file is imported', () => {
    const source = fromJsonl(resolve(scratch(), 'absent.jsonl'))
    expect(() => source()).toThrow('Could not read eval cases')
  })
})

describe('hillclimbReporter', () => {
  test('should write the layout the harness report builders read', async () => {
    const root = scratch()
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'billing' }]), pricing: PRICING }),
        cases: cases('a', 'b/2'),
        grade: ({ response }) => ({ ok: response.text === 'billing' ? 1 : 0 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: hillclimbReporter({ root, cwd: root }),
      }),
    )

    const directory = resolve(root, 'triage', 'baseline')
    expect(result.location).toBe(directory)
    const rows = readFileSync(resolve(directory, 'results.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as EvalRow)
    expect(rows.map((row) => row.caseId)).toEqual(['a', 'b/2'])
    // A case id is free text; the trace file name is not, and the row keeps the true id.
    // A sanitized id carries a digest, so `b/2` cannot land on `b_2`'s file.
    const traces = readdirSync(resolve(directory, 'traces')).sort()
    expect(traces[0]).toBe('a_rep1.json')
    expect(traces[1]).toMatch(/^b_2-[0-9a-f]{8}_rep1\.json$/)
    expect(JSON.parse(readFileSync(resolve(directory, 'summary.json'), 'utf8')).metrics[0].mean).toBe(1)
    expect(existsSync(resolve(directory, 'errors.jsonl'))).toBe(false)

    const state = JSON.parse(readFileSync(resolve(directory, '_state.json'), 'utf8')) as {
      seed: number
      split: { dev: string[]; test: string[] }
    }
    expect([...state.split.dev, ...state.split.test].sort()).toEqual(['a', 'b/2'])
    // One case per stratum: assigning within a stratum would put every case on one side.
    expect(state.split.dev).toHaveLength(1)
    expect(state.split.test).toHaveLength(1)
    expect(typeof state.seed).toBe('number')
  })

  test('should split every case the eval declares, not the --cases selection', async () => {
    const root = scratch()
    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a', 'b', 'c', 'd'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: hillclimbReporter({ root, cwd: root }),
      }),
      { cases: 2 },
    )

    const state = JSON.parse(readFileSync(resolve(root, 'triage', 'baseline', '_state.json'), 'utf8')) as {
      split: { dev: string[]; test: string[] }
    }
    // The file is written once: a first run capped at two must not fix the split at two ids.
    expect([...state.split.dev, ...state.split.test].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('should give two case ids that sanitize alike their own trace file', async () => {
    const root = scratch()
    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: [{ id: 'refund/1', input: 'one' }, { id: 'refund_1', input: 'two' }],
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: hillclimbReporter({ root, cwd: root }),
      }),
    )

    const traces = readdirSync(resolve(root, 'triage', 'baseline', 'traces'))
    expect(traces).toHaveLength(2)
  })

  test('should repair a results.jsonl whose last append was cut short', async () => {
    const root = scratch()
    const directory = resolve(root, 'triage', 'baseline')
    mkdirSync(resolve(directory, 'traces'), { recursive: true })
    writeFileSync(resolve(directory, 'results.jsonl'), '{"caseId":"a","rep":1,"status":"ok","scores":{"ok":1},"usage":{}}\n{"caseId":"b","rep')

    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('b'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: hillclimbReporter({ root, cwd: root }),
      }),
    )

    // Appending onto the fragment would have made the replacement row unreadable too.
    const lines = readFileSync(resolve(directory, 'results.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '')
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ caseId: 'b', rep: 1 })
  })

  test('should never edit _state.json after writing it, and should resume over results.jsonl', async () => {
    const root = scratch()
    const define = (ids: string[]) =>
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases(...ids),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: hillclimbReporter({ root, cwd: root }),
      })

    await runEval(define(['a']))
    const directory = resolve(root, 'triage', 'baseline')
    const first = readFileSync(resolve(directory, '_state.json'), 'utf8')

    const second = await runEval(define(['a', 'b']))

    expect(readFileSync(resolve(directory, '_state.json'), 'utf8')).toBe(first)
    expect(readFileSync(resolve(directory, 'results.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2)
    expect(second.summary.rows).toBe(2)
  })

  test('should count the cases its rows cover when a re-run selects fewer', async () => {
    const root = scratch()
    const define = () =>
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a', 'b', 'c'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: hillclimbReporter({ root, cwd: root }),
      })

    await runEval(define())
    const second = await runEval(define(), { cases: 1 })

    // The rows include what the resume skipped, so "1 cases ... = 3 rows" would contradict itself.
    expect(second.summary.rows).toBe(3)
    expect(second.summary.cases).toBe(3)
  })

  test('should put an attempt that produced nothing scorable in errors.jsonl', async () => {
    const root = scratch()
    await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]), pricing: PRICING }),
        cases: cases('a'),
        grade: (): { ok: number } => { throw new Error('boom') },
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: hillclimbReporter({ root, cwd: root }),
      }),
    )

    const errors = readFileSync(resolve(root, 'triage', 'baseline', 'errors.jsonl'), 'utf8').trim()
    expect(JSON.parse(errors)).toMatchObject({ caseId: 'a', failure: 'grade', attempts: 1 })
  })

  test('should write nothing on a dry run while still naming the directory', async () => {
    const root = scratch()
    const result = await runEval(
      defineEval({
        flow: 'triage',
        agent: Triager,
        app: () => bootEvalApp({ model: answering([{ text: 'x' }]) }),
        cases: cases('a'),
        grade: () => ({ ok: 1 }),
        metrics: [{ id: 'ok', kind: 'binary' }],
        reporter: hillclimbReporter({ root, cwd: root }),
      }),
      { dryRun: true },
    )

    expect(result.location).toBe(resolve(root, 'triage', 'baseline'))
    expect(existsSync(resolve(root, 'triage'))).toBe(false)
  })
})

describe('cost and statistics', () => {
  test('should charge cached reads and writes at their own rate, and the input rate without one', () => {
    const usage = { inputTokens: 1000, noCacheInputTokens: 400, cacheReadTokens: 500, cacheWriteTokens: 100, outputTokens: 200 }
    expect(computeCostUsd(usage, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }))
      .toBeCloseTo((400 * 3 + 500 * 0.3 + 100 * 3.75 + 200 * 15) / 1_000_000, 12)
    expect(computeCostUsd(usage, { input: 3, output: 15 }))
      .toBeCloseTo((400 * 3 + 500 * 3 + 100 * 3 + 200 * 15) / 1_000_000, 12)
    expect(computeCostUsd(usage, undefined)).toBeUndefined()
  })

  test('should report the half-width for a binary metric only, over the rows in the mean', () => {
    const row = (id: string, scores: Record<string, number>, status: 'ok' | 'truncated' = 'ok'): EvalRow => ({
      caseId: id, rep: 1, status, input: '', text: '', output: '', scores,
      provider: 'p', model: 'm', modelProvider: 'mp', usage: {}, finishReason: 'stop', steps: 1, toolCalls: [],
      tags: [], durationMs: 0, startedAt: '',
    })

    const summaries = summarizeMetrics(
      [row('a', { hit: 1, score: 0.5 }), row('b', { hit: 0, score: 0.9 }), row('c', { hit: 1, score: 1 }, 'truncated')],
      [{ id: 'hit', kind: 'binary' }, { id: 'score', kind: 'score' }],
    )

    expect(summaries[0]).toMatchObject({ mean: 0.5, n: 2 })
    expect(summaries[0]!.halfWidth).toBeCloseTo(1 / Math.sqrt(2), 12)
    expect(summaries[1]).toMatchObject({ mean: 0.7, n: 2 })
    expect(summaries[1]!.halfWidth).toBeUndefined()
  })
})
