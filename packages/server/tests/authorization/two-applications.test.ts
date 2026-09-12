/**
 * The RFC 0023 acceptance test: two Applications booted in one process, each
 * with a different policy for the same model, each authorizes by its own.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { Controller, Policy, createApp, type Application } from '../../src'
import { authorizeMiddleware, can, getGate } from '../../src/authorization'
import { resetDefaultApplication, useAsDefaultApplication } from '../../src/http/default-application'
import { resetWarnOnce } from '../../src/support/warn-once'

class Doc {}

class OpenPolicy extends Policy {
  update(): boolean {
    return true
  }
}

class ClosedPolicy extends Policy {
  update(): boolean {
    return false
  }
}

class DocController extends Controller {
  async update() {
    await this.authorize('update', [Doc, { id: 1 }])
    return this.json({ ok: true })
  }

  async check() {
    return this.json({ allowed: await this.can('update', [Doc, { id: 1 }]) })
  }

  async guarded() {
    return this.json({ ok: true })
  }
}

async function bootWith(PolicyClass: typeof OpenPolicy | typeof ClosedPolicy): Promise<Application> {
  const app = createApp({
    routes: (router) => {
      router.put('/docs/:id', [DocController, 'update'])
      router.get('/docs/:id/can', [DocController, 'check'])
      router.get('/guarded', [DocController, 'guarded'], authorizeMiddleware('enter'))
    },
  })
  await app.boot()
  const gate = app.container.make('gate')
  gate.policy(Doc, PolicyClass)
  gate.define('enter', () => PolicyClass === OpenPolicy)
  return app
}

async function status(app: Application, path: string, method = 'GET'): Promise<number> {
  return (await app.fetch(new Request(`http://example.com${path}`, { method }))).status
}

describe('two Applications in one process (RFC 0023)', () => {
  let warn: ReturnType<typeof spyOn>

  beforeEach(() => {
    resetDefaultApplication()
    resetWarnOnce()
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    resetDefaultApplication()
  })

  it('lets each app authorize by its own policy, whichever was constructed last', async () => {
    const open = await bootWith(OpenPolicy)
    const closed = await bootWith(ClosedPolicy)

    expect(await status(open, '/docs/1', 'PUT')).toBe(200)
    expect(await status(closed, '/docs/1', 'PUT')).toBe(403)

    const openCan = await open.fetch(new Request('http://example.com/docs/1/can'))
    const closedCan = await closed.fetch(new Request('http://example.com/docs/1/can'))
    expect(await openCan.json()).toEqual({ allowed: true })
    expect(await closedCan.json()).toEqual({ allowed: false })
  })

  it('gives the authorization middleware the gate of the app serving the request', async () => {
    const open = await bootWith(OpenPolicy)
    const closed = await bootWith(ClosedPolicy)

    expect(await status(open, '/guarded')).toBe(200)
    expect(await status(closed, '/guarded')).toBe(403)
    // Request handling never went ambient, so nothing was ambiguous to warn about.
    expect(warn).not.toHaveBeenCalled()
  })

  it('resolves the functional helpers from the default application, warning once', async () => {
    const open = await bootWith(OpenPolicy)
    const closed = await bootWith(ClosedPolicy)

    expect(getGate()).toBe(closed.container.make('gate'))
    expect(await can('enter')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)

    useAsDefaultApplication(open)
    expect(getGate()).toBe(open.container.make('gate'))
    expect(await can('enter')).toBe(true)
  })
})
