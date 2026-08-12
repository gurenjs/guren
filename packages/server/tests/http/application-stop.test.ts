import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Application } from '../../src/http/Application'

/**
 * Like the port-binding tests next door, these bind real sockets on 127.0.0.1
 * rather than stubbing `Bun.serve`. What `stop()` has to deliver is that the
 * socket is genuinely released — a stub can only report that `stop()` was
 * called, which is the one thing never in doubt.
 */

type BunServerSlot = { __gurenActiveServer?: unknown }

const apps: Application[] = []

function track(app: Application): Application {
  apps.push(app)
  return app
}

function activeServerSlot(): unknown {
  return (globalThis as BunServerSlot).__gurenActiveServer
}

beforeEach(() => {
  // Every sibling listen/stop test suppresses the banner; without this the
  // ASCII art buries the results of this file's own assertions.
  process.env.GUREN_DEV_BANNER = '0'
})

afterEach(async () => {
  delete process.env.GUREN_DEV_BANNER
  while (apps.length > 0) {
    await apps.pop()?.stop(true)
  }
})

describe('Application.stop', () => {
  it('releases the port so the same one can be bound again', async () => {
    const app = track(new Application())
    const address = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })

    // The server answers before the stop — otherwise a rebind below proves
    // nothing, since an app that never bound also leaves the port free.
    expect((await fetch(`${address.url}/__does-not-exist`)).status).toBe(404)

    await app.stop(true)

    // Re-binding the *same* port is the assertion. A refused connection could
    // just as well mean the socket is in TIME_WAIT.
    const second = track(new Application())
    const rebound = await second.listen({
      port: address.port,
      hostname: '127.0.0.1',
      vite: false,
      // No walk: a fallback would quietly bind the next port up and pass.
      portFallback: false,
    })

    expect(rebound.port).toBe(address.port)
    expect((await fetch(`${rebound.url}/__does-not-exist`)).status).toBe(404)
  })

  /**
   * `address` reports where `listen()` put this app, and its own docs treat a
   * stop that the framework can see as clearing it. `stop()` is now such a stop,
   * so leaving the stored address behind would have the accessor naming a socket
   * that is closed.
   */
  it('stops reporting an address once stopped, and reports the new one after a restart', async () => {
    const app = track(new Application())
    expect(app.address).toBeUndefined()

    const first = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
    expect(app.address).toEqual(first)

    await app.stop(true)
    expect(app.address).toBeUndefined()

    const second = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
    expect(app.address).toEqual(second)
  })

  it('is a no-op when nothing is listening, and when called twice', async () => {
    const neverListened = track(new Application())
    await neverListened.stop()

    const app = track(new Application())
    await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })

    await app.stop(true)
    await app.stop(true)
  })

  it('lets the same instance listen again after being stopped', async () => {
    const app = track(new Application())

    const first = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
    await app.stop(true)

    const second = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })

    expect((await fetch(`${second.url}/__does-not-exist`)).status).toBe(404)
    // The restarted instance owns the global teardown slot again — otherwise a
    // SIGINT after a restart would find nothing to stop.
    expect(activeServerSlot()).toBeDefined()
  })

  /**
   * Every other real-server case here forces connections closed. The default is
   * the graceful path, and it is the one a caller gets by writing `app.stop()` —
   * so it needs its own case rather than being covered only by the never-listened
   * app, which returns before reaching Bun's `stop()` at all.
   */
  it('releases the socket on a graceful stop with no argument', async () => {
    const app = track(new Application())
    const address = await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
    expect((await fetch(`${address.url}/__does-not-exist`)).status).toBe(404)

    await app.stop()

    const rebind = track(new Application())
    const rebound = await rebind.listen({
      port: address.port,
      hostname: '127.0.0.1',
      vite: false,
      portFallback: false,
    })
    expect(rebound.port).toBe(address.port)
  })

  /**
   * `listen()` guards its process-handler registration with a flag that only
   * ever went `true`. `stop()` has to detach the handlers, not just reset the
   * flag: resetting alone would let every stop/listen cycle attach another set,
   * and leaving the flag set would be the same leak deferred to whoever resets
   * it next.
   */
  it('detaches its process teardown handlers, and re-attaches exactly one set', async () => {
    const counts = () => ({
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    })

    const app = track(new Application())
    const before = counts()

    await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
    const listening = counts()
    expect(listening.exit).toBe(before.exit + 1)
    expect(listening.sigint).toBe(before.sigint + 1)
    expect(listening.sigterm).toBe(before.sigterm + 1)

    await app.stop(true)
    expect(counts()).toEqual(before)

    // Cycling must not accumulate: without the detach, each pass leaves another
    // handler behind and Node starts warning about a leak at eleven.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await app.listen({ port: 0, hostname: '127.0.0.1', vite: false })
      expect(counts()).toEqual(listening)
      await app.stop(true)
      expect(counts()).toEqual(before)
    }
  })

  /**
   * The counterpart to the listener-count test above, and the half it cannot
   * reach: that the re-attached handlers actually *fire*. `listenerCount` only
   * reports Bun's bookkeeping, and a process exiting has its sockets reclaimed
   * by the OS either way — so the discriminating signal is the exit *code*. A
   * restarted app whose SIGTERM handler went missing dies by signal instead of
   * exiting 0 through the teardown.
   */
  it('still tears down on a signal after a stop/restart cycle', async () => {
    const child = Bun.spawn(
      ['bun', 'run', new URL('./application-stop-restart-fixture.ts', import.meta.url).pathname],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    try {
      const reader = child.stdout.getReader()
      const decoder = new TextDecoder()
      let output = ''
      while (!output.includes('READY')) {
        const { done, value } = await reader.read()
        if (done) {
          throw new Error(`Fixture exited before it was ready: ${output}`)
        }
        output += decoder.decode(value, { stream: true })
      }

      child.kill('SIGTERM')
      await child.exited

      // `signalCode` set means the default disposition killed it — the handler
      // that should have exited 0 was gone.
      expect(child.signalCode).toBeNull()
      expect(child.exitCode).toBe(0)
    } finally {
      child.kill('SIGKILL')
    }
  }, 20_000)

  it('leaves the global teardown slot alone when it points at another server', async () => {
    const first = track(new Application())
    await first.listen({ port: 0, hostname: '127.0.0.1', vite: false })

    // A second listen() force-stops whatever the slot holds and takes it over
    // — the hot-reload path. The first app still remembers its own (now dead)
    // server, so its stop() must not clear a slot that has moved on, or the
    // live server loses its exit teardown.
    const second = track(new Application())
    await second.listen({ port: 0, hostname: '127.0.0.1', vite: false })

    const slotAfterSecondListen = activeServerSlot()
    expect(slotAfterSecondListen).toBeDefined()

    await first.stop(true)

    expect(activeServerSlot()).toBe(slotAfterSecondListen)

    // And the owner still clears it when it is the one stopping.
    await second.stop(true)
    expect(activeServerSlot()).toBeUndefined()
  })
})
