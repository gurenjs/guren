type UnknownChannelEvents = Record<string, Record<string, unknown>>

type EventNameFor<TChannelEvents extends UnknownChannelEvents, TChannel extends keyof TChannelEvents & string> =
  keyof TChannelEvents[TChannel] & string

type EventPayloadFor<
  TChannelEvents extends UnknownChannelEvents,
  TChannel extends keyof TChannelEvents & string,
  TEvent extends EventNameFor<TChannelEvents, TChannel>,
> = TChannelEvents[TChannel][TEvent]

export interface UseChannelOptions {
  /**
   * The SSE route mounted with `broadcast.sseMiddleware()`. The channel a
   * subscription asks for is appended as `?channels=<name>`; an endpoint that
   * already carries a query string gets `&channels=`.
   */
  endpoint?: string
  withCredentials?: boolean
  eventSourceFactory?: (url: string, init: EventSourceInit) => EventSource
}

/**
 * The URL a subscription opens: the SSE endpoint plus the channel it wants.
 *
 * The server subscribes nothing on its own — `sseMiddleware()` reads
 * `?channels=` when the stream opens and delivers only what that names. A
 * stream opened without it receives `connected` and `ping` and nothing else,
 * which is exactly what `useChannel('orders')` used to open.
 */
export function channelStreamUrl(endpoint: string, channel: string): string {
  const separator = endpoint.includes('?') ? '&' : '?'
  return `${endpoint}${separator}channels=${encodeURIComponent(channel)}`
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
 *
 * Each `useChannel(name)` call opens its own EventSource on
 * `endpoint?channels=name`. One stream per channel is deliberate: the server
 * dispatches by *event* name, not channel name, so two channels sharing an
 * event name on one stream would be indistinguishable to `on()`. The server
 * authorizes the requested channel against the user its SSE route resolves
 * (`sseMiddleware({ getUser })`), so a private or presence channel works here
 * too when that route knows who is connecting; a channel it refuses is simply
 * left out of the `connected` event's `channels` list and delivers nothing.
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
    const eventSource = eventSourceFactory(channelStreamUrl(endpoint, channel), { withCredentials })
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
