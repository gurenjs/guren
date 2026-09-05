import { describe, test, expect, afterEach, beforeEach } from 'bun:test'

import {
  configureAgentRuntime,
  freezeAgentRegistrations,
  findRegistrationByName,
  resetAgentRuntime,
  resolveAgentRuntime,
  type AgentRuntime,
} from './latch'

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    app: { fetch: async () => new Response('ok') },
    tools: [],
    registrations: new Map(),
    ...overrides,
  }
}

describe('the agent runtime latch', () => {
  // Both sides. The latch is module-global by design, and `bun test` shares one
  // module registry across a run's files — so another file's fixture is
  // already latched when this one starts, and the unconfigured case would
  // otherwise pass or fail depending on file order.
  beforeEach(() => {
    resetAgentRuntime()
  })

  afterEach(() => {
    resetAgentRuntime()
  })

  test('should refuse to be read before it is configured, naming both fixes', async () => {
    // Two callers reach this message and they have nothing else in common: a
    // deploy whose build wiring is missing, and a test whose setup is. Naming
    // only one of them sends half the readers to the wrong file.
    let error: unknown
    try {
      await resolveAgentRuntime()
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('cloudflare:build')
    expect((error as Error).message).toContain('configureAgentRuntime')
  })

  test('should hand back what was configured', async () => {
    const configured = runtime()
    configureAgentRuntime(configured)
    expect(await resolveAgentRuntime()).toBe(configured)
  })

  test('should treat a second configuration with the same runtime as a no-op', async () => {
    const configured = runtime()
    configureAgentRuntime(configured)
    configureAgentRuntime(configured)
    expect(await resolveAgentRuntime()).toBe(configured)
  })

  test('should let the latest published runtime win', async () => {
    // `agentsPlugin.boot` mints a fresh runtime object every time, so a refusal
    // here would fire on the ordinary path — an app's own test suite standing
    // up a second `TestApp`. The one-application-per-isolate guarantee belongs
    // to the boot wiring (the resolver), not to this setter.
    configureAgentRuntime(runtime())
    const second = runtime()
    configureAgentRuntime(second)

    expect(await resolveAgentRuntime()).toBe(second)
  })

  test('should call a resolver with the env it is given', async () => {
    const resolved = runtime()
    const seen: unknown[] = []
    configureAgentRuntime((env) => {
      seen.push(env)
      return resolved
    })

    const env = { DB: 'binding' }
    expect(await resolveAgentRuntime(env)).toBe(resolved)
    expect(seen).toEqual([env])
  })

  test('should await an async resolver', async () => {
    const resolved = runtime()
    configureAgentRuntime(async () => resolved)
    expect(await resolveAgentRuntime()).toBe(resolved)
  })

  test('should accept a resolver that publishes instead of returning', async () => {
    // The shape Part 2b writes: the resolver boots the application, and
    // `agentsPlugin` inside it is what publishes the runtime.
    const published = runtime()
    configureAgentRuntime(() => {
      configureAgentRuntime(published)
    })
    expect(await resolveAgentRuntime()).toBe(published)
  })

  test('should prefer the published runtime over one a resolver returned', async () => {
    // One object per isolate, so one set of rate budgets and one registration
    // map. Two would be two answers to "what may this agent call".
    const published = runtime()
    configureAgentRuntime(() => {
      configureAgentRuntime(published)
      return runtime()
    })
    expect(await resolveAgentRuntime()).toBe(published)
  })

  test('should refuse a resolver that publishes nothing and returns nothing', async () => {
    configureAgentRuntime(() => {})
    await expect(resolveAgentRuntime()).rejects.toThrow(/published no runtime/)
  })

  test('should refuse a second, different resolver', () => {
    configureAgentRuntime(() => {})
    expect(() => configureAgentRuntime(() => {})).toThrow(/different resolver/)
  })

  test('should run a resolver once for callers that arrive together', async () => {
    // An alarm and a request can wake the isolate at the same instant. Without
    // an in-flight latch each would run the resolver, and each would therefore
    // boot the application: two module graphs, two sets of rate budgets, and
    // whichever finished last silently owning the runtime slot.
    let invocations = 0
    const resolved = runtime()
    configureAgentRuntime(async () => {
      invocations++
      await new Promise((settle) => setTimeout(settle, 5))
      return resolved
    })

    const [first, second] = await Promise.all([resolveAgentRuntime(), resolveAgentRuntime()])

    expect(invocations).toBe(1)
    expect(first).toBe(resolved)
    expect(second).toBe(resolved)
  })

  test('should let a failed resolution be retried rather than latching the rejection', async () => {
    // A boot that failed on a transient condition must be retryable; a latched
    // rejection would make one bad wake permanent for the life of the isolate.
    let attempts = 0
    const resolved = runtime()
    configureAgentRuntime(async () => {
      attempts++
      if (attempts === 1) throw new Error('transient')
      return resolved
    })

    await expect(resolveAgentRuntime()).rejects.toThrow('transient')
    expect(await resolveAgentRuntime()).toBe(resolved)
    expect(attempts).toBe(2)
  })

  test('should not read a resolver once a runtime is published', async () => {
    let calls = 0
    configureAgentRuntime(() => {
      calls++
    })
    const published = runtime()
    configureAgentRuntime(published)

    expect(await resolveAgentRuntime()).toBe(published)
    expect(calls).toBe(0)
  })
})

describe('env identity (RFC 0017 §6)', () => {
  beforeEach(() => {
    resetAgentRuntime()
  })

  afterEach(() => {
    resetAgentRuntime()
  })

  test('should refuse a second resolution for a different env object', async () => {
    // Two envs in one isolate means two deployments sharing a module graph, and
    // a tool call would then run against bindings that are not its own. Joining
    // the first resolution silently is the failure this replaces.
    configureAgentRuntime(async () => runtime())

    await resolveAgentRuntime({ DB: 'first' })
    await expect(resolveAgentRuntime({ DB: 'second' })).rejects.toThrow(/different `env` object/)
  })

  test('should accept the same env object again', async () => {
    const env = { DB: 'one' }
    const resolved = runtime()
    configureAgentRuntime(async () => resolved)

    expect(await resolveAgentRuntime(env)).toBe(resolved)
    expect(await resolveAgentRuntime(env)).toBe(resolved)
  })

  test('should join an in-flight resolution rather than returning a half-published slot', async () => {
    // `agentsPlugin` publishes from inside the application's own boot, so the
    // slot appears while later providers are still booting. A caller that read
    // the slot the moment it appeared would dispatch into a half-assembled app.
    let finishBoot: () => void = () => {}
    const gate = new Promise<void>((settle) => {
      finishBoot = settle
    })
    const published = runtime()
    let bootFinished = false

    configureAgentRuntime(async () => {
      configureAgentRuntime(published)
      await gate
      bootFinished = true
    })

    const pending = resolveAgentRuntime()
    // The slot is already filled here, and the answer must still wait.
    finishBoot()
    expect(await pending).toBe(published)
    expect(bootFinished).toBe(true)
  })
})

describe('freezeAgentRegistrations', () => {
  test('should freeze each registration and its abilities', () => {
    const registrations = new Map([
      ['Triager', { name: 'triager', abilities: ['tool:posts.index'] }],
    ])
    const frozen = freezeAgentRegistrations(registrations)
    const registration = frozen.get('Triager')!

    // The array the scope gate judges by is the same object the audit principal
    // reports. Widening it in process would authorize a call the record does
    // not show — under strict mode this throws instead.
    expect(Object.isFrozen(registration.abilities)).toBe(true)
    expect(Object.isFrozen(registration)).toBe(true)
    expect(() => (registration.abilities as string[]).push('tool:posts.destroy')).toThrow()
    expect(registration.abilities).toEqual(['tool:posts.index'])
  })
})

describe('findRegistrationByName', () => {
  test('should find a registration by its config key, not its export name', () => {
    const target = { name: 'triager', abilities: ['tool:posts.index'] }
    const configured = runtime({
      registrations: new Map([
        ['Reader', { name: 'reader', abilities: [] }],
        ['Triager', target],
      ]),
    })

    expect(findRegistrationByName(configured, 'triager')).toBe(target)
    expect(findRegistrationByName(configured, 'Triager')).toBeUndefined()
  })
})
