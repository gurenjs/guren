import { describe, expect, it } from 'bun:test'
import { runCheck } from '../src/check'
import { gatingResults, type CheckResult } from '../src/check-result'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const CONTROLLER = 'app/Http/Controllers/OrderController.ts'
const EVENTS = 'app/Events/OrderEvents.ts'
const ROUTES = 'routes/web.ts'

function controller(props: string, imports = "import { Controller, always, defer, live } from '@guren/core'"): string {
  return `${imports}
import { OrderUpdated, OrderShipped } from '../../Events/OrderEvents'

export class OrderController extends Controller {
  async show() {
    return this.inertia('orders/Show', ${props})
  }
}
`
}

const EVENT_CLASSES = `export class OrderUpdated {
  constructor(readonly orderId: number) {}
  broadcastOn() {
    return [\`private-orders.\${this.orderId}\`]
  }
}

export class OrderShipped {
  static eventName = 'order.shipped'
  constructor(readonly orderId: number) {}
  broadcastOn() {
    return [\`private-orders.\${this.orderId}\`]
  }
}
`

const SOCKET_ROUTE = `export function registerWebRoutes(router: any, broadcast: any) {
  router.get('/broadcasting/socket', broadcast.webSocketMiddleware())
}
`

/** The live-props results of a full check run over a throwaway app. */
async function liveResults(files: Record<string, string>): Promise<{ results: CheckResult[]; gating: CheckResult[] }> {
  const workspace = await createTempWorkspace('guren-live-props-check-')
  try {
    await writeWorkspaceFiles(workspace.dir, files)
    const report = await runCheck({ cwd: workspace.dir })
    return {
      results: report.checks.filter((result) => result.key.startsWith('live-props')),
      gating: gatingResults(report).filter((result) => result.key.startsWith('live-props')),
    }
  } finally {
    await workspace.cleanup()
  }
}

describe('guren check live props', () => {
  it('contributes nothing for an app whose controllers never import live', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ order: 1 }', "import { Controller } from '@guren/core'"),
      [EVENTS]: EVENT_CLASSES,
    })

    expect(results).toEqual([])
  })

  it('warns, without failing the gate, when no route mounts the socket', async () => {
    const { results, gating } = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, { on: new OrderShipped(1) }) }'),
      [EVENTS]: EVENT_CLASSES,
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([['live-props:socket-route', 'warn']])
    expect(results[0]?.advisory).toBe(true)
    expect(gating).toEqual([])
  })

  it('passes the socket route once a routes file mounts webSocketMiddleware()', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, { on: new OrderShipped(1) }) }'),
      [EVENTS]: EVENT_CLASSES,
      [ROUTES]: SOCKET_ROUTE,
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([['live-props:socket-route', 'pass']])
  })

  it('warns on an event broadcast under its class name, and names the file to pin it in', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, { on: [new OrderUpdated(1), new OrderShipped(1), { event: "x", channel: "y" }] }) }'),
      [EVENTS]: EVENT_CLASSES,
      [ROUTES]: SOCKET_ROUTE,
    })

    const unpinned = results.filter((result) => result.key.startsWith('live-props:event-name'))
    expect(unpinned.map((result) => result.key)).toEqual(['live-props:event-name:OrderController.show:OrderUpdated'])
    expect(unpinned[0]?.suggestion).toContain('app/Events/OrderEvents.ts')
  })

  it('warns on live() inside always() or a deferred callback', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller(
        '{ a: always(live(1, { on: new OrderShipped(1) })), b: defer(() => live(1, { on: new OrderShipped(1) })), c: live(always(1), { on: new OrderShipped(1) }) }',
      ),
      [EVENTS]: EVENT_CLASSES,
      [ROUTES]: SOCKET_ROUTE,
    })

    const outermost = results.filter((result) => result.key.startsWith('live-props:outermost'))
    expect(outermost.map((result) => result.message.match(/in (\w+\(\))/)?.[1])).toEqual(['always()', 'defer()'])
  })

  it('reports options it cannot read as unverifiable, never as a pass', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, options), other: live(1, { ...options }) }'),
      [EVENTS]: EVENT_CLASSES,
      [ROUTES]: SOCKET_ROUTE,
    })

    expect(results.filter((result) => result.key.startsWith('live-props:unverifiable')).map((result) => result.status)).toEqual(['warn', 'warn'])
  })
})
