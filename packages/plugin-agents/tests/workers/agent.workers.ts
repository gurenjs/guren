/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { auditedPrincipals, type StrayAgent, type TestAgent } from './worker'

/**
 * The half of the durable surface that Bun cannot reach.
 *
 * What these cases are about needs a real workerd: a Durable Object's own
 * identity as the principal, and an alarm waking an instance to call a tool.
 * The gates are covered on Bun; this proves `src/agent.ts` reaches them.
 */

interface TestEnv {
  TEST_AGENT: DurableObjectNamespace<TestAgent>
  STRAY_AGENT: DurableObjectNamespace<StrayAgent>
}

const bindings = env as unknown as TestEnv

function testAgent(name: string): DurableObjectStub<TestAgent> {
  return bindings.TEST_AGENT.get(bindings.TEST_AGENT.idFromName(name))
}

describe('GurenAgent.tools inside a Durable Object', () => {
  it('should execute a granted tool through the invocation pipeline', async () => {
    const result = await runInDurableObject(testAgent('allowed'), (agent) =>
      agent.tools.call('posts.index', {}))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.outcome.status).toBe(200)
  })

  it('should deny a tool outside the registration scopes', async () => {
    const result = await runInDurableObject(testAgent('denied'), (agent) =>
      agent.tools.call('posts.store', { title: 'nope' }))

    expect(result.denied).toBe(true)
    if (!result.denied) return
    expect(result.reason).toBe('scope')
  })

  it('should authenticate as the Durable Object instance, not the class', async () => {
    // Asserted through the *audit trail*, not through `agent.name`: the
    // principal id is what isolates approvals, and reading the DO's name back
    // proves only that the SDK knows it — not that the id built from it reached
    // the pipeline. Two instances of one class must produce two ids.
    auditedPrincipals.length = 0

    await runInDurableObject(testAgent('inbox-a'), (agent) => agent.tools.call('posts.index', {}))
    await runInDurableObject(testAgent('inbox-b'), (agent) => agent.tools.call('posts.index', {}))
    await new Promise((settle) => setTimeout(settle, 0))

    expect(auditedPrincipals).toEqual(['agent:triager:inbox-a', 'agent:triager:inbox-b'])
  })

  it('should percent-encode an instance name so ids cannot collide', async () => {
    // `agent:triager:a:b` would otherwise be ambiguous with a differently split
    // name/instance pair, and approvals are isolated by that string.
    auditedPrincipals.length = 0

    await runInDurableObject(testAgent('inbox:1'), (agent) => agent.tools.call('posts.index', {}))
    await new Promise((settle) => setTimeout(settle, 0))

    expect(auditedPrincipals).toEqual(['agent:triager:inbox%3A1'])
  })

  it('should throw for a class config/agents.ts never registered', async () => {
    const stray = bindings.STRAY_AGENT.get(bindings.STRAY_AGENT.idFromName('stray'))
    await expect(
      runInDurableObject(stray, (agent) => agent.tools.call('posts.index', {})),
    ).rejects.toThrow(/config\/agents\.ts/)
  })
})

describe('a scheduled callback that calls a tool', () => {
  it('should run the callback on the alarm and reach the application', async () => {
    const stub = testAgent('scheduled')

    await runInDurableObject(stub, (agent) => agent.schedule(1, 'sweep' as never))
    // Not invoked by scheduling it: the whole point is that the work happens on
    // a later wake, with nothing but durable state carried across.
    expect(await runInDurableObject(stub, (agent) => agent.state)).toEqual({
      lastTitle: null,
      sweeps: 0,
    })

    // `runDurableObjectAlarm` fires the alarm *now*, and the SDK's handler then
    // runs only the schedules that are due — so the delay has to actually
    // elapse first. Its boolean is deliberately not asserted: workerd may have
    // delivered the alarm itself in the meantime, which reports `false` for a
    // callback that ran perfectly well. The state is the invariant.
    const state = await until(async () => {
      await runDurableObjectAlarm(stub)
      const current = await runInDurableObject(stub, (agent) => agent.state)
      return current.sweeps > 0 ? current : undefined
    })

    // Checkpointed into state, not into a local: the call happened inside an
    // alarm, and nothing else survives the wake.
    expect(state).toEqual({ lastTitle: 'Hello', sweeps: 1 })
  })
})

/** Poll `probe` until it answers, or fail the test rather than hang the suite. */
async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const answer = await probe()
    if (answer !== undefined) return answer
    if (Date.now() > deadline) {
      throw new Error('The scheduled callback never ran within 5s.')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
