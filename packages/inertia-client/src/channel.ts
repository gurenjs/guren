type UnknownChannelEvents = Record<string, Record<string, unknown>>

type EventNameFor<TChannelEvents extends UnknownChannelEvents, TChannel extends keyof TChannelEvents & string> =
  keyof TChannelEvents[TChannel] & string

type EventPayloadFor<
  TChannelEvents extends UnknownChannelEvents,
  TChannel extends keyof TChannelEvents & string,
  TEvent extends EventNameFor<TChannelEvents, TChannel>,
> = TChannelEvents[TChannel][TEvent]

export interface UseChannelOptions {
  endpoint?: string
  withCredentials?: boolean
  eventSourceFactory?: (url: string, init: EventSourceInit) => EventSource
}

export type ChannelSubscription<
  TChannelEvents extends UnknownChannelEvents,
  TChannel extends keyof TChannelEvents & string,
> = {
  on<TEvent extends EventNameFor<TChannelEvents, TChannel>>(
    event: TEvent,
    handler: (payload: EventPayloadFor<TChannelEvents, TChannel, TEvent>) => void,
  ): () => void
  close(): void
}

/**
 * Create a typed channel subscription factory backed by EventSource.
 */
export function createUseChannel<TChannelEvents extends UnknownChannelEvents>(
  options: UseChannelOptions = {},
) {
  const endpoint = options.endpoint ?? '/broadcasting/events'
  const withCredentials = options.withCredentials ?? true
  const eventSourceFactory = options.eventSourceFactory ?? ((url, init) => new EventSource(url, init))

  return function useChannel<TChannel extends keyof TChannelEvents & string>(
    channel: TChannel,
  ): ChannelSubscription<TChannelEvents, TChannel> {
    const eventSource = eventSourceFactory(endpoint, { withCredentials })
    const listeners = new Map<string, Set<EventListener>>()

    const attach = (event: string, listener: EventListener): void => {
      eventSource.addEventListener(event, listener)
      const existing = listeners.get(event) ?? new Set<EventListener>()
      existing.add(listener)
      listeners.set(event, existing)
    }

    const detach = (event: string, listener: EventListener): void => {
      eventSource.removeEventListener(event, listener)
      const existing = listeners.get(event)
      if (!existing) return
      existing.delete(listener)
      if (existing.size === 0) {
        listeners.delete(event)
      }
    }

    const close = (): void => {
      for (const [event, eventListeners] of listeners.entries()) {
        for (const listener of eventListeners) {
          eventSource.removeEventListener(event, listener)
        }
      }
      listeners.clear()
      eventSource.close()
    }

    const on = <TEvent extends EventNameFor<TChannelEvents, TChannel>>(
      event: TEvent,
      handler: (payload: EventPayloadFor<TChannelEvents, TChannel, TEvent>) => void,
    ): (() => void) => {
      const listener: EventListener = (incoming) => {
        if (!(incoming instanceof MessageEvent) || typeof incoming.data !== 'string') return
        const payload = JSON.parse(incoming.data) as EventPayloadFor<TChannelEvents, TChannel, TEvent>
        handler(payload)
      }
      attach(event, listener)

      return () => detach(event, listener)
    }

    return {
      on,
      close,
    }
  }
}
