import { describe, expect, test } from 'bun:test'
import { Event } from '../../src/events/Event'
import { inertia, type InertiaPagePayload } from '../../src/mvc/inertia/InertiaEngine'
import { always, defer, isLiveProp, live, resolveInertiaProps, type LiveListener } from '../../src/mvc/inertia/props'

class OrderUpdated extends Event {
  static override eventName = 'OrderUpdated'

  constructor(readonly orderId: number) {
    super()
  }

  broadcastOn(): string[] {
    return [`private-orders.${this.orderId}`]
  }
}

class ActivityLogged {
  broadcastOn(): string[] {
    return ['activity', 'presence-team.1']
  }

  broadcastAs(): string {
    return 'activity.logged'
  }
}

const ORDER_LISTENER: LiveListener = { channel: { name: 'orders.1', type: 'private' }, events: ['OrderUpdated'] }

function partial(only: string[], except: string[] = []) {
  return { only: new Set(only), except: new Set(except) }
}

describe('live()', () => {
  test('reads the channel and name off an event instance, unprefixed as Inertia expects', () => {
    const prop = live({ id: 1 }, { on: new OrderUpdated(1) })

    expect(isLiveProp(prop)).toBe(true)
    expect(prop.entry).toEqual({ listeners: [ORDER_LISTENER] })
  })

  test('groups listeners per channel, deduplicates events, and keeps the throttle', () => {
    const prop = live(1, {
      on: [
        new OrderUpdated(1),
        new ActivityLogged(),
        { event: 'OrderCancelled', channel: 'private-orders.1' },
        { event: 'OrderUpdated', channel: ['private-orders.1'] },
      ],
      throttle: 4000,
    })

    expect(prop.entry).toEqual({
      listeners: [
        { channel: { name: 'orders.1', type: 'private' }, events: ['OrderUpdated', 'OrderCancelled'] },
        { channel: { name: 'activity', type: 'public' }, events: ['activity.logged'] },
        { channel: { name: 'team.1', type: 'presence' }, events: ['activity.logged'] },
      ],
      throttle: 4000,
    })
  })

  test('throws in the action that wrote a listener nothing could deliver', () => {
    expect(() => live(1, { on: [] })).toThrow('at least one event')
    expect(() => live(1, { on: { event: 'X', channel: [] } })).toThrow('has no channel')
    expect(() => live(1, { on: { event: 'X' } as never })).toThrow('has no channel')
    expect(() => live(1, { on: { broadcastOn: () => [], broadcastAs: () => 'X' } })).toThrow('has no channel')
    expect(() => live(1, { on: { event: 'X', channel: 'private-encrypted-orders.1' } })).toThrow('no encrypted channels')
    expect(() => live(1, { on: { event: 'X', channel: 'private-' } })).toThrow('names no channel')
    expect(() => live(1, { on: { broadcastOn: () => ['a'] } })).toThrow('needs a name')
    expect(() => live(1, { on: new OrderUpdated(1), throttle: -1 })).toThrow('throttle')
    expect(() => live(1, { on: OrderUpdated as never })).toThrow('pass new OrderUpdated(…), not the class')
  })

  test('refuses to wrap, or be wrapped by, another prop helper the wrong way round', () => {
    const inner = live(1, { on: new OrderUpdated(1) })

    expect(() => live(inner, { on: new OrderUpdated(1) })).toThrow('cannot wrap another live prop')
    expect(() => always(inner as never)).toThrow('outermost')
  })

  test('serializes as its value, as always() does', () => {
    expect(JSON.stringify({ order: live({ id: 1 }, { on: new OrderUpdated(1) }) })).toBe('{"order":{"id":1}}')
    expect(JSON.stringify({ errors: live(always({}), { on: new OrderUpdated(1) }) })).toBe('{"errors":{}}')
  })
})

describe('resolveInertiaProps() with live props', () => {
  const props = () => ({
    order: live(() => ({ id: 1 }), { on: new OrderUpdated(1) }),
    activity: live(defer(() => ['a']), { on: new OrderUpdated(1), throttle: 2000 }),
    errors: live(always({}), { on: new OrderUpdated(1) }),
    title: 'Order',
  })

  test('lists every live prop on a full visit, a deferred one included', async () => {
    const page = await resolveInertiaProps(props(), undefined)

    expect(page.props).toEqual({ order: { id: 1 }, errors: {}, title: 'Order' })
    expect(page.deferredProps).toEqual({ default: ['activity'] })
    expect(page.liveProps).toEqual({
      order: { listeners: [ORDER_LISTENER] },
      activity: { listeners: [ORDER_LISTENER], throttle: 2000 },
      errors: { listeners: [ORDER_LISTENER] },
    })
  })

  test('lists only the live props a partial reload resolves', async () => {
    const page = await resolveInertiaProps(props(), partial(['activity']))

    expect(page.props).toEqual({ activity: ['a'], errors: {} })
    expect(page.liveProps).toEqual({
      activity: { listeners: [ORDER_LISTENER], throttle: 2000 },
      errors: { listeners: [ORDER_LISTENER] },
    })
  })

  test('sends no entry for a plain key a partial reload resolves, live props beside it or not', async () => {
    const input = { order: { id: 1 }, errors: always({}), activity: live(defer(() => ['a']), { on: new OrderUpdated(1) }) }

    expect(await resolveInertiaProps(input, partial(['order']))).toEqual({ props: { order: { id: 1 }, errors: {} } })
    expect(await resolveInertiaProps({ order: { id: 1 } }, partial(['order']))).toEqual({ props: { order: { id: 1 } } })
  })

  test('omits liveProps when nothing is live', async () => {
    expect(await resolveInertiaProps({ title: 'Order' }, undefined)).toEqual({ props: { title: 'Order' } })
    expect(await resolveInertiaProps({ title: 'Order' }, partial([], ['title']))).toEqual({ props: {} })
  })

  test('rejects a live prop a lazy or deferred value resolves to', async () => {
    const lazy = resolveInertiaProps({ order: () => live(1, { on: new OrderUpdated(1) }) }, undefined)
    await expect(lazy).rejects.toThrow('outermost')

    const deferred = resolveInertiaProps({ order: defer(() => live(1, { on: new OrderUpdated(1) }) as never) }, partial(['order']))
    await expect(deferred).rejects.toThrow('outermost')
  })
})

describe('inertia() with live props', () => {
  test('carries liveProps in the JSON page and the HTML document', async () => {
    const props = { order: live({ id: 1 }, { on: new OrderUpdated(1) }) }
    const request = new Request('http://example.com/orders/1', { headers: { 'X-Inertia': 'true' } })

    const page = (await (await inertia('orders/Show', props, { request })).json()) as InertiaPagePayload
    expect(page.props).toEqual({ order: { id: 1 } })
    expect(page.liveProps).toEqual({ order: { listeners: [ORDER_LISTENER] } })

    const html = await (await inertia('orders/Show', props, { url: '/orders/1' })).text()
    expect(html).toContain('"liveProps":{"order":{"listeners":[{"channel":{"name":"orders.1","type":"private"},"events":["OrderUpdated"]}]}}')
  })
})
