import { describe, expect, it } from 'bun:test'
import { createUseChannel } from '../src/channel'

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

describe('createUseChannel', () => {
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
