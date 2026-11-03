import { describe, expect, it } from 'bun:test'
import { runCheck } from '../src/check'
import { gatingResults, type CheckResult } from '../src/check-result'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const CONTROLLER = 'app/Http/Controllers/OrderController.ts'
const EVENTS = 'app/Events/OrderEvents.ts'
const ROUTES = 'routes/web.ts'

function controller(
  props: string,
  imports = "import { Controller, always, defer, live } from '@guren/core'",
  events = "import { OrderUpdated, OrderShipped } from '../../Events/OrderEvents'",
): string {
  return `${imports}
${events}

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

  it('reads broadcastOn() written as a class field, as the runtime calls it', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, { on: new OrderUpdated(1) }) }'),
      [EVENTS]: 'export class OrderUpdated {\n  constructor(readonly orderId: number) {}\n  broadcastOn = () => [`private-orders.${this.orderId}`]\n}\nexport class OrderShipped {}\n',
      [ROUTES]: SOCKET_ROUTE,
    })

    expect(results.map((result) => result.key)).toContain('live-props:event-name:OrderController.show:OrderUpdated')
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

  it('reports an event it cannot resolve to a class as unverifiable, never as a pass', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ a: live(1, { on: event }), b: live(1, { on: [new Events.OrderUpdated(1)] }), c: live(1, { on: new Missing() }) }'),
      [EVENTS]: EVENT_CLASSES,
      [ROUTES]: SOCKET_ROUTE,
    })

    const unverifiable = results.filter((result) => result.key.startsWith('live-props:unverifiable'))
    expect(unverifiable).toHaveLength(3)
    expect(unverifiable.map((result) => result.message).join(' ')).toContain('Missing, whose class the check cannot find')
    expect(results.some((result) => result.key.startsWith('live-props:event-name'))).toBe(false)
  })

  it('judges the class the controller imports when two files declare the name', async () => {
    const pinned = 'export class OrderUpdated {\n  static eventName = "order.updated"\n  broadcastOn() { return ["orders"] }\n}\nexport class OrderShipped {}\n'
    const unpinned = 'export class OrderUpdated {\n  broadcastOn() { return ["orders"] }\n}\n'
    const imported = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, { on: new OrderUpdated(1) }) }'),
      [EVENTS]: pinned,
      'modules/billing/app/Events/OrderUpdated.ts': unpinned,
      [ROUTES]: SOCKET_ROUTE,
    })
    expect(imported.results.filter((result) => result.key.startsWith('live-props:event-name'))).toEqual([])
    expect(imported.results.filter((result) => result.key.startsWith('live-props:unverifiable'))).toEqual([])

    const swapped = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, { on: new OrderUpdated(1) }) }'),
      [EVENTS]: `${unpinned}export class OrderShipped {}\n`,
      'modules/billing/app/Events/OrderUpdated.ts': pinned,
      [ROUTES]: SOCKET_ROUTE,
    })
    expect(swapped.results.map((result) => result.key)).toContain('live-props:event-name:OrderController.show:OrderUpdated')
  })

  it('follows base classes the app declares, as the runtime does', async () => {
    const events = [
      'export class OrderEvent { broadcastOn() { return ["orders"] } }',
      'export class Named extends OrderEvent { broadcastAs() { return "named" } }',
      'export class OrderUpdated extends OrderEvent {}',
      'export class OrderShipped extends Named {}',
      'export class Getter { static get eventName() { return "getter" }\n broadcastOn() { return ["orders"] } }',
      'export class Opaque extends ExternalBase { broadcastOn() { return ["orders"] } }',
    ].join('\n')
    const { results } = await liveResults({
      [CONTROLLER]: controller(
        '{ order: live(1, { on: [new OrderUpdated(1), new OrderShipped(1), new Getter(), new Opaque()] }) }',
        undefined,
        "import { OrderUpdated, OrderShipped, Getter, Opaque } from '../../Events/OrderEvents'",
      ),
      [EVENTS]: events,
      [ROUTES]: SOCKET_ROUTE,
    })

    expect(results.filter((result) => result.key.startsWith('live-props:event-name')).map((result) => result.key)).toEqual([
      'live-props:event-name:OrderController.show:OrderUpdated',
    ])
    expect(results.find((result) => result.key.startsWith('live-props:unverifiable'))?.message).toContain('Opaque, whose base class the check cannot read')
  })

  it('reports options it cannot read as unverifiable, never as a pass', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, options), other: live(1, { ...options }), last: live(1, { on: new OrderShipped(1), ...options }) }'),
      [EVENTS]: EVENT_CLASSES,
      [ROUTES]: SOCKET_ROUTE,
    })

    expect(results.filter((result) => result.key.startsWith('live-props:unverifiable')).map((result) => result.status)).toEqual(['warn', 'warn', 'warn'])
  })

  it('reads the name as broadcastNameOf() does: inherited instance names pin, an empty field does not', async () => {
    const events = [
      'export class OrderEvent { eventName = "order"; broadcastOn() { return ["orders"] } }',
      'export class OrderUpdated extends OrderEvent {}',
      'export class OrderShipped { eventName!: string; static eventName: string; broadcastOn() { return ["orders"] } }',
      'export class Cleared { static eventName = undefined; broadcastAs() { return undefined } broadcastOn() { return ["orders"] } }',
    ].join('\n')
    const { results } = await liveResults({
      [CONTROLLER]: controller(
        '{ order: live(1, { on: [new OrderUpdated(1), new OrderShipped(1), new Cleared()] }) }',
        undefined,
        "import { OrderUpdated, OrderShipped, Cleared } from '../../Events/OrderEvents'",
      ),
      [EVENTS]: events,
      [ROUTES]: SOCKET_ROUTE,
    })

    expect(results.filter((result) => result.key.startsWith('live-props:event-name')).map((result) => result.key)).toEqual([
      'live-props:event-name:OrderController.show:OrderShipped',
      'live-props:event-name:OrderController.show:Cleared',
    ])
  })

  it('never judges an app class for an event the controller imports from a package', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, { on: new OrderShipped(1) }) }', undefined, "import { OrderShipped } from '@acme/events'"),
      [EVENTS]: EVENT_CLASSES,
      [ROUTES]: SOCKET_ROUTE,
    })

    expect(results.find((result) => result.key.startsWith('live-props:unverifiable'))?.message).toContain('imported from @acme/events')
  })

  it('finds the socket route in a module routes.ts, mounted with a bare call', async () => {
    const { results } = await liveResults({
      [CONTROLLER]: controller('{ order: live(1, { on: new OrderShipped(1) }) }'),
      [EVENTS]: EVENT_CLASSES,
      'modules/orders/routes.ts': 'export function routes(router: any, broadcast: any) {\n  const { webSocketMiddleware } = broadcast\n  router.get("/broadcasting/socket", webSocketMiddleware())\n}\n',
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([['live-props:socket-route', 'pass']])
  })
})
