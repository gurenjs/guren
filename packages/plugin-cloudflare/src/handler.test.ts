import { beforeEach, describe, expect, test } from 'bun:test'
import { getWorkersEnv, resetWorkersEnv } from './env'
import { createWorkersHandler, type WorkersAppLike, type WorkersExecutionContext } from './handler'

interface TestEnv {
  DB: string
}

function createExecutionContext(): WorkersExecutionContext {
  return {
    waitUntil() {},
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createWorkersHandler', () => {
  beforeEach(() => {
    resetWorkersEnv()
  })

  test('should call app.boot exactly once across multiple sequential fetches', async () => {
    let bootCalls = 0
    const app: WorkersAppLike = {
      async boot() {
        bootCalls += 1
      },
      fetch() {
        return new Response('ok')
      },
    }
    const handler = createWorkersHandler(app)
    const ctx = createExecutionContext()

    await handler.fetch(new Request('https://example.com/one'), {}, ctx)
    await handler.fetch(new Request('https://example.com/two'), {}, ctx)
    await handler.fetch(new Request('https://example.com/three'), {}, ctx)

    expect(bootCalls).toBe(1)
  })

  test('should share a single boot across concurrent first requests', async () => {
    let bootCalls = 0
    const bootDeferred = deferred<void>()
    const app: WorkersAppLike = {
      boot() {
        bootCalls += 1
        return bootDeferred.promise
      },
      fetch(request) {
        return new Response(`ok:${new URL(request.url).pathname}`)
      },
    }
    const handler = createWorkersHandler(app)
    const ctx = createExecutionContext()

    const first = handler.fetch(new Request('https://example.com/first'), {}, ctx)
    const second = handler.fetch(new Request('https://example.com/second'), {}, ctx)

    bootDeferred.resolve()

    const [firstResponse, secondResponse] = await Promise.all([first, second])

    expect(bootCalls).toBe(1)
    expect(await firstResponse.text()).toBe('ok:/first')
    expect(await secondResponse.text()).toBe('ok:/second')
  })

  test('should clear boot promise and env holder on boot failure, then retry cleanly', async () => {
    let bootCalls = 0
    const app: WorkersAppLike = {
      async boot() {
        bootCalls += 1
        if (bootCalls === 1) {
          throw new Error('boot failed')
        }
      },
      fetch() {
        return new Response('ok')
      },
    }
    const handler = createWorkersHandler(app)
    const ctx = createExecutionContext()
    const firstEnv = { DB: 'first-db' }
    const secondEnv = { DB: 'second-db' }

    await expect(
      handler.fetch(new Request('https://example.com/one'), firstEnv, ctx),
    ).rejects.toThrow('boot failed')

    const response = await handler.fetch(new Request('https://example.com/two'), secondEnv, ctx)

    expect(bootCalls).toBe(2)
    expect(await response.text()).toBe('ok')
    expect(getWorkersEnv<TestEnv>()).toBe(secondEnv)
  })

  test('should pass each request its own env and ctx through to app.fetch', async () => {
    const app: WorkersAppLike = {
      async boot() {},
      fetch(request, env) {
        return new Response(JSON.stringify({ path: new URL(request.url).pathname, env }))
      },
    }
    const handler = createWorkersHandler(app)
    const ctx = createExecutionContext()
    const firstEnv = { DB: 'first-db' }
    const secondEnv = { DB: 'second-db' }

    const firstResponse = await handler.fetch(new Request('https://example.com/first'), firstEnv, ctx)
    const secondResponse = await handler.fetch(new Request('https://example.com/second'), secondEnv, ctx)

    expect(await firstResponse.json()).toEqual({ path: '/first', env: firstEnv })
    expect(await secondResponse.json()).toEqual({ path: '/second', env: secondEnv })
    expect(getWorkersEnv<TestEnv>()).toBe(firstEnv)
  })
})
