/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:workers'
import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

import type { StrayAgent } from './app/app/Agents/StrayAgent'
import type { TestAgent } from './app/app/Agents/TestAgent'

/**
 * The half of the durable surface Bun cannot reach, run against the worker
 * `guren cloudflare:build` generated (RFC 0017 §7) rather than a stand-in. The
 * suite never imports the fixture app: what it reads about the app's own state
 * comes back over HTTP, so no assertion rests on sharing a module instance.
 */

interface TestEnv {
  TEST_AGENT: DurableObjectNamespace<TestAgent>
  STRAY_AGENT: DurableObjectNamespace<StrayAgent>
}

const bindings = env as unknown as TestEnv

interface Probe {
  boots: number
  principals: string[]
  target: { agent: string; instance: string } | null
}

function testAgent(name: string): DurableObjectStub<TestAgent> {
  return bindings.TEST_AGENT.get(bindings.TEST_AGENT.idFromName(name))
}

async function probe(): Promise<Probe> {
  const response = await SELF.fetch('https://fixture.test/__probe')
  expect(response.status).toBe(200)
  return (await response.json()) as Probe
}

async function setRouting(mode: 'absent' | 'allow' | 'deny' | 'response' | 'throw'): Promise<void> {
  const response = await SELF.fetch(`https://fixture.test/__probe/routing?mode=${mode}`)
  expect(response.status).toBe(200)
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
    await setRouting('absent')

    await runInDurableObject(testAgent('inbox-a'), (agent) => agent.tools.call('posts.index', {}))
    await runInDurableObject(testAgent('inbox-b'), (agent) => agent.tools.call('posts.index', {}))
    await new Promise((settle) => setTimeout(settle, 0))

    expect((await probe()).principals).toEqual(['agent:triager:inbox-a', 'agent:triager:inbox-b'])
  })

  it('should percent-encode an instance name so ids cannot collide', async () => {
    // `agent:triager:a:b` would otherwise be ambiguous with a differently split
    // name/instance pair, and approvals are isolated by that string.
    await setRouting('absent')

    await runInDurableObject(testAgent('inbox:1'), (agent) => agent.tools.call('posts.index', {}))
    await new Promise((settle) => setTimeout(settle, 0))

    expect((await probe()).principals).toEqual(['agent:triager:inbox%3A1'])
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
      settled: [],
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
    expect(state).toEqual({ lastTitle: 'Hello', sweeps: 1, settled: [] })
  })
})

describe('the boot the generated worker shares', () => {
  // Module state is shared across this file, so by now both entrypoints have
  // driven the isolate many times over — the point is one boot for all of them.
  // The two do *not* share an `env` object (a Durable Object and the Worker
  // entrypoint are handed different ones), so the latch keyed on the app is what
  // makes it one boot. Each ordering alone is pinned by `handler.test.ts` on Bun.
  it('should have booted the application exactly once across every wake and request', async () => {
    const result = await runInDurableObject(testAgent('boot-order'), (agent) =>
      agent.tools.call('posts.index', {}))

    expect(result.ok).toBe(true)
    expect((await probe()).boots).toBe(1)
  })
})

describe('the /agents/* mount', () => {
  beforeEach(async () => {
    await setRouting('absent')
  })

  it('should refuse every request when the registry declares no routing', async () => {
    const response = await SELF.fetch('https://fixture.test/agents/test-agent/unrouted')

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'forbidden' })
  })

  it('should refuse an unknown binding the same way rather than let the SDK answer 400', async () => {
    // The SDK answers 400 for a binding it cannot find *before* either hook
    // runs; refusing the whole prefix first keeps an anonymous caller from
    // telling bound names from unbound ones.
    const response = await SELF.fetch('https://fixture.test/agents/no-such-agent/x')

    expect(response.status).toBe(403)
  })

  it('should reserve the whole prefix once an authorizer is configured', async () => {
    await setRouting('allow')

    // An app route under /agents/ is unreachable: the SDK owns the prefix and
    // answers for a binding it cannot find. Pinned so the README's claim holds.
    const response = await SELF.fetch('https://fixture.test/agents/no-such-agent/x')

    expect(response.status).toBe(400)
  })

  it('should refuse a WebSocket upgrade the same way', async () => {
    const response = await SELF.fetch('https://fixture.test/agents/test-agent/unrouted', {
      headers: { Upgrade: 'websocket' },
    })

    expect(response.status).toBe(403)
    expect(response.webSocket).toBeNull()
  })

  it('should reach the agent when the authorizer allows the request', async () => {
    await setRouting('allow')

    const response = await SELF.fetch('https://fixture.test/agents/test-agent/greeted')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ reached: 'greeted' })
  })

  it('should report the binding name and instance the SDK resolved', async () => {
    await setRouting('allow')

    await SELF.fetch('https://fixture.test/agents/test-agent/greeted')

    // `AgentRouteMatch.className` is the *binding* name, not the class and not
    // the config key; the URL segment is that binding kebab-cased.
    expect((await probe()).target).toEqual({ agent: 'TEST_AGENT', instance: 'greeted' })
  })

  it('should refuse when the authorizer says no', async () => {
    await setRouting('deny')

    const response = await SELF.fetch('https://fixture.test/agents/test-agent/greeted')

    expect(response.status).toBe(403)
  })

  it('should fail closed when the authorizer throws', async () => {
    await setRouting('throw')

    // The SDK runs the hook before `namespace.get(id).fetch()`, so the
    // exception leaves the Durable Object unbuilt. Whether the platform turns
    // it into a 5xx or a rejected fetch, it is never the agent's 200.
    const status = await SELF.fetch('https://fixture.test/agents/test-agent/greeted').then(
      (response) => response.status,
      () => 'rejected' as const,
    )

    expect(status === 'rejected' || status >= 500).toBe(true)
    expect((await probe()).target).toBeNull()
  })

  it('should return an authorizer own Response unchanged', async () => {
    await setRouting('response')

    const response = await SELF.fetch('https://fixture.test/agents/test-agent/greeted')

    expect(response.status).toBe(418)
    expect(await response.text()).toBe('teapot')
  })

  it('should refuse a Durable Object binding that is not a registered agent', async () => {
    await setRouting('allow')

    // STRAY_AGENT is bound in wrangler.jsonc but registered nowhere: the SDK
    // would route to it like any binding, and the allowlist is what stops that.
    const response = await SELF.fetch('https://fixture.test/agents/stray-agent/x')

    expect(response.status).toBe(403)
    expect((await probe()).target).toBeNull()
  })

  it('should leave every other path to the application', async () => {
    const response = await SELF.fetch('https://fixture.test/posts')

    // The guard answers `undefined` off its prefix, so the app still serves its
    // own routes — a mount that swallowed everything would pass the 403 cases
    // above while breaking the app.
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ posts: [{ id: 1, title: 'Hello' }] })
  })
})

/** Poll until `attempt` answers, or fail the test rather than hang the suite. */
async function until<T>(attempt: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const answer = await attempt()
    if (answer !== undefined) return answer
    if (Date.now() > deadline) {
      throw new Error('The scheduled callback never ran within 5s.')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
