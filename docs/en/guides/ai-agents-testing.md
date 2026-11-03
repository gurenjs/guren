# Testing AI Agents

An agent is tested at two levels. A test with `fakeAi()` scripts the model's answers while the agent's tools still run through your routes, so it proves the wiring and runs in `bun test` like any other test. An eval runs the agent against the real model over a set of cases and scores the result. Writing the agent itself is covered in [AI Agents](./ai-agents.md).

## Scripting the Model with `fakeAi()`

`app.fakeAi()` from `@guren/testing` replaces the `ai` binding of an app booted with `TestApp.fromApp(app)`. It scripts the model and nothing else: tools still dispatch through the pipeline into your routes, so a test sees the scope gate, the policies and the approval gate do their work. Shortened from the test in `examples/agents`, which also creates the ticket first and checks that the tool's real answer carries it:

```ts
import { beforeAll, describe, expect, test } from 'bun:test'
import type { TestApp } from '@guren/testing'
import { TicketDigest } from '../app/Ai/Agents/TicketDigest'
import { operatorToken, testApp } from './support/app'

let http: TestApp
let bearer: string

beforeAll(async () => {
  http = await testApp() // TestApp.fromApp(app) over a migrated test database
  bearer = await operatorToken()
})

describe('TicketDigest', () => {
  test('should read tickets through the real route and answer with the scripted digest', async () => {
    using ai = http.fakeAi()
    ai.respond(TicketDigest, [
      {
        toolCalls: [{ name: 'tickets_index', input: { status: 'open' } }],
        then: { output: { summary: 'One printer fire.', staleTicketIds: [] } },
      },
    ])

    const body = await (
      await http.withHeaders({ Authorization: `Bearer ${bearer}` }).post('/ops/agents/digest', {}).assertOk()
    ).json<{ digest: { summary: string } }>()

    expect(body.digest.summary).toBe('One printer fire.')
    ai.assertPrompted(TicketDigest, (input) => input.startsWith('Today is '))
    expect(ai.calls(TicketDigest)[0]!.toolCalls[0]?.name).toBe('tickets_index')
  })
})
```

Install `ai` next to `@guren/plugin-ai`: the fake is built on the AI SDK's mock model.

`respond(Agent, [...])` queues one scripted response per future prompt of that agent:

| Response | The model |
|---|---|
| `'text'` or `{ text }` | answers with the text |
| `{ output }` | answers with that value as the structured output |
| `{ toolCalls: [{ name, input }], then }` | requests those tool calls, then answers with `then` |

`calls(Agent)` returns each prompt with its `input`, `principal`, `response` and `toolCalls`. Each tool call records what the real tool returned, or the error it threw. For a `stream()` call, `toolCalls` fills in as the test reads the response body.

`assertPrompted(Agent, predicate?)`, `assertNotPrompted(Agent, predicate)` and `assertNeverPrompted(Agent)` check the prompts. A prompt with nothing scripted throws, and disposing the fake at the end of the `using` block throws again naming the agent, because a route usually turns the first error into a 500 whose body says nothing. Disposal also fails when the loop stopped (through `stopWhen`) before reaching the scripted answer.

The fake answers `conversations()` from the real store, so a scripted prompt with `conversation: true` writes the same rows it would in production.
`respondEmbeddings()` and `respondImages()` script the other two calls:

```ts
using ai = app.fakeAi()
ai.respondEmbeddings([[0.1, 0.2], [0.3, 0.4]])   // one vector per value
ai.respondImages(['<base64>', ['<base64>', '<base64>']])   // one entry per image() call
```

An array of vectors is drawn one per *value*, so `embedMany(['a', 'b'])` takes two of them however the SDK batches the request; a function (`(value) => number[]`) answers every value instead and never runs out. `embedCalls()` and `imageCalls()` return what each call asked for, and `assertEmbedded(predicate?)`, `assertNeverEmbedded()`, `assertGeneratedImage(predicate?)` and `assertNeverGeneratedImage()` mirror the prompt assertions. An unscripted `embed()` or `image()` fails the call and the disposal, as an unscripted prompt does, and so does a provider whose `config/ai.ts` entry declares no model of that kind.

`respondEvaluations([...])` queues one answer set per future `evaluate()`, a value per question:

```ts
ai.respondEvaluations([{ category: 'billing', urgent: 0.97 }])
```

| Value | The answer |
|---|---|
| a string, for a `choice` | that option at probability 1, the others at 0 |
| a number, for a `boolean` | that probability |
| a number, for a `score` | that position; an integer also carries a one-hot distribution |
| an AI SDK answer object | passed through as it is |

Each value is checked against the questions when consumed. A choice outside the options, a score past the last level or a probability outside 0 to 1 fails the call and the disposal, so the fake cannot answer what the real model could not, and the scripted model runs under the real `experimental_evaluate`, so the SDK's own validation applies as well. `evaluationCalls()` returns each call's `state`, `questions`, `provider` and `answers`; `assertEvaluated(predicate?)` and `assertNeverEvaluated()` mirror the prompt assertions.

A fake proves the wiring. Whether the instructions and tool descriptions get the right answer out of a real model is the other measurement, and that one calls the model.

## Evals

An eval runs the agent against the real model over a set of cases and scores what it did. It costs money and it is not deterministic, so it is opt-in: nothing in `guren check` or `guren gate` ever runs one, and an eval never replaces the fake in a test file.

An eval file declares the agent, a disposable app per case, the cases, a grader and the metrics it returns:

```ts
// tests/evals/ticket-digest.eval.ts
import { defineEval, fromJsonl, type EvalCase } from '@guren/plugin-ai/eval'
import { TicketDigest } from '../../app/Ai/Agents/TicketDigest'
import { Ticket } from '../../app/Models/Ticket'
import app from '../../src/app'

type DigestCase = EvalCase<{ staleIds: number[] }, Array<{ id: number; title: string; createdAt: string }>>

export default defineEval({
  agent: TicketDigest,
  app: async () => {
    await app.boot()
    return app
  },
  cases: fromJsonl<DigestCase>('tests/evals/ticket-digest/cases.jsonl'),
  as: () => ({ id: 1 }),
  setup: async (_app, kase) => {
    for (const seed of kase.seed ?? []) {
      await Ticket.create({ ...seed, status: 'open', createdAt: new Date(seed.createdAt), updatedAt: new Date() })
    }
  },
  grade: ({ response, expected }) => {
    const found = response.output.staleTicketIds
    const wanted = expected?.staleIds ?? []
    return { stale: found.length === wanted.length && wanted.every((id) => found.includes(id)) ? 1 : 0 }
  },
  metrics: [{ id: 'stale', kind: 'binary' }],
})
```

Each case gets its own app, so the agent's `appTools()` dispatch through the pipeline as they do in production, and `grade()` reads the end state the tools left behind rather than the transcript. `judge` adds a second agent for what a program cannot score, on a different provider, and its cost is recorded separately so it cannot dampen a difference between variants.

Cases are one JSON object per line, each with `id` and `input`, plus any `expected`, `seed` and `tags` your grader and setup read.

```bash
bunx guren ai:eval ticket-digest --dry-run                  # resolve the cases, call no model, write nothing
bunx guren ai:eval ticket-digest --reps 2 --max-cost-usd 5  # the baseline
bunx guren ai:eval ticket-digest --variant v1 --cases 20    # one round against it
```

`--concurrency` runs cases in parallel, `--file` and `--dir` point at an eval the flow name does not resolve, and `--json` prints the summary for a script.

Results land under `.claude/hillclimb/<flow>/<variant>/`: a row per case and repetition, a trace per run, a summary, and a sidecar for attempts that produced nothing scorable, each with its failure class. Guren writes the data and ships no viewer. That layout is the one the claude-api harness's report builder reads, and `defineEval({ reporter })` swaps it for another.

Three things the summary is careful about:

- **Cost comes from the response's own usage** and the provider's `pricing` in `config/ai.ts`, server-side tool calls included when `perThousandRequests` prices them. A provider with no `pricing` yields rows with no cost rather than a zero, and `--max-cost-usd` says it cannot hold.
- **A truncated answer** (`finishReason` of `'length'`) is kept out of every metric mean and counted beside it, so a variant cannot look better by truncating more.
- **`--max-cost-usd` is a soft ceiling.** No new case starts once the derived cost crosses it, and cases already running finish.
