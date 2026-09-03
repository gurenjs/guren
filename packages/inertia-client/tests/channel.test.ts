import { describe, expect, it } from 'bun:test'
import { channelStreamUrl, createUseChannel } from '../src/channel'

type ListenerMap = Map<string, Set<EventListener>>

class MockEventSource {
  listeners: ListenerMap = new Map()
  closed = false

  addEventListener(event: string, listener: EventListener): void {
    const current = this.listeners.get(event) ?? new Set<EventListener>()
    current.add(listener)
    this.listeners.set(event, current)
  }

  removeEventListener(event: string, listener: EventListener): void {
    const current = this.listeners.get(event)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      this.listeners.delete(event)
    }
  }

  emit(event: string, payload: unknown): void {
    const current = this.listeners.get(event)
    if (!current) return
    const message = new MessageEvent(event, {
      data: JSON.stringify(payload),
    })
    for (const listener of current) {
      listener(message)
    }
  }

  close(): void {
    this.closed = true
  }
}

describe('channelStreamUrl', () => {
  it('appends the channel as ?channels= to a bare endpoint', () => {
    expect(channelStreamUrl('/broadcasting/events', 'notifications')).toBe(
      '/broadcasting/events?channels=notifications',
    )
  })

  it('joins with & when the endpoint already has a query string', () => {
    expect(channelStreamUrl('/broadcasting/events?token=abc', 'notifications')).toBe(
      '/broadcasting/events?token=abc&channels=notifications',
    )
  })

  it('encodes characters that would split or terminate the query', () => {
    expect(channelStreamUrl('/broadcasting/events', 'chat room&1#x')).toBe(
      '/broadcasting/events?channels=chat%20room%261%23x',
    )
  })
})

describe('createUseChannel', () => {
  // The server subscribes only what `?channels=` names when the stream opens,
  // so a hook that opened the bare endpoint received nothing channel-specific.
  it('opens the EventSource with the requested channel in ?channels=', () => {
    type Events = {
      notifications: { NewMessage: { content: string } }
      'private-orders.123': { OrderUpdated: { status: string } }
    }

    const opened: Array<{ url: string; init: EventSourceInit }> = []
    const useChannel = createUseChannel<Events>({
      eventSourceFactory: (url, init) => {
        opened.push({ url, init })
        return new MockEventSource() as unknown as EventSource
      },
    })

    useChannel('notifications')
    useChannel('private-orders.123')

    expect(opened.map((entry) => entry.url)).toEqual([
      '/broadcasting/events?channels=notifications',
      '/broadcasting/events?channels=private-orders.123',
    ])
    expect(opened[0].init).toEqual({ withCredentials: true })
  })

  it('keeps a custom endpoint and its query string ahead of the channel', () => {
    type Events = {
      notifications: { NewMessage: { content: string } }
    }

    let openedUrl = ''
    const useChannel = createUseChannel<Events>({
      endpoint: '/realtime/stream?token=abc',
      withCredentials: false,
      eventSourceFactory: (url) => {
        openedUrl = url
        return new MockEventSource() as unknown as EventSource
      },
    })

    useChannel('notifications')

    expect(openedUrl).toBe('/realtime/stream?token=abc&channels=notifications')
  })

  it('subscribes to typed events and parses payload', () => {
    type Events = {
      notifications: {
        NewMessage: { content: string }
      }
    }

    const source = new MockEventSource()
    const useChannel = createUseChannel<Events>({
      eventSourceFactory: () => source as unknown as EventSource,
    })
    const channel = useChannel('notifications')

    let captured = ''
    channel.on('NewMessage', (payload) => {
      captured = payload.content
    })

    source.emit('NewMessage', { content: 'hello' })
    expect(captured).toBe('hello')
  })

  it('returns an unsubscribe function for each listener', () => {
    type Events = {
      notifications: {
        NewMessage: { content: string }
      }
    }

    const source = new MockEventSource()
    const useChannel = createUseChannel<Events>({
      eventSourceFactory: () => source as unknown as EventSource,
    })
    const channel = useChannel('notifications')
    const off = channel.on('NewMessage', () => {})

    expect(source.listeners.get('NewMessage')?.size).toBe(1)
    off()
    expect(source.listeners.has('NewMessage')).toBe(false)
  })

  it('closes the underlying EventSource and removes listeners', () => {
    type Events = {
      notifications: {
        NewMessage: { content: string }
      }
    }

    const source = new MockEventSource()
    const useChannel = createUseChannel<Events>({
      eventSourceFactory: () => source as unknown as EventSource,
    })
    const channel = useChannel('notifications')
    channel.on('NewMessage', () => {})

    channel.close()

    expect(source.closed).toBe(true)
    expect(source.listeners.size).toBe(0)
  })
})
