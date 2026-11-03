/**
 * The live-props transport over Guren's own `/broadcasting/socket` (RFC 0037 §3).
 * The types restate `@inertiajs/core`'s `LiveTransport`/`LiveOptions` from 3.11,
 * since this package still admits an Inertia that does not declare them; they
 * must stay structurally assignable to Inertia's (a test pins it).
 */

export type LiveChannelType = 'public' | 'private' | 'presence' | 'encrypted-private'

export interface LiveChannel {
  name: string
  type: LiveChannelType | (string & {})
  params?: Record<string, unknown>
}

export type LiveEventHandler = (payload: unknown) => void

export interface LiveTransport {
  subscribe(channel: LiveChannel, event: string, handler: LiveEventHandler): () => void
  socketId?: () => string | null | undefined
  onStatusChange?(callback: (connected: boolean) => void): () => void
}

export interface LiveOptions {
  transport: LiveTransport
  throttle?: number
  pauseWhenHidden?: boolean
}

export interface GurenLiveOptions {
  /** The `webSocketMiddleware()` route, resolved against `location`. Default `/broadcasting/socket`. */
  url?: string
  /** Milliseconds between two reloads of one prop, passed to Inertia (its default is 1000). */
  throttle?: number
  /** Hold reloads while the tab is hidden, passed to Inertia (its default is on). */
  pauseWhenHidden?: boolean
  webSocketFactory?: (url: string) => WebSocket
  /** Milliseconds the socket stays open after its last channel is released, so moving between two live pages keeps it. */
  idleTimeout?: number
}

/** Below the server's 32, at which it closes the socket with 1008. */
const MAX_OUTSTANDING = 16
const RECONNECT_BASE = 1000
const RECONNECT_MAX = 30_000
/** Attempts in a row that end without `connected`: a runtime that answers 501 never will. */
const MAX_FAILED_ATTEMPTS = 5
const DEFAULT_IDLE_TIMEOUT = 5000

const PREFIXES: Record<string, string> = { public: '', private: 'private-', presence: 'presence-' }

interface Frame {
  event: string
  channel?: string
  data?: unknown
}

/** Inertia's `{ name, type }` back to the wire name `broadcastOn()` returned. */
export function liveWireName(channel: LiveChannel): string | undefined {
  const prefix = PREFIXES[channel.type]
  return prefix === undefined ? undefined : `${prefix}${channel.name}`
}

function socketUrl(path: string): string {
  const base = typeof location === 'undefined' ? 'http://localhost/' : location.href
  const url = new URL(path, base)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  return url.href
}

/** The payload without `__inertia`: Inertia writes `__inertia.props` into the page unasked, and live props here only reload. */
function withoutEnvelope(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('__inertia' in payload)) return payload
  const { __inertia: _envelope, ...rest } = payload as Record<string, unknown>
  return rest
}

function parseFrame(raw: unknown): Frame | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const frame = JSON.parse(raw) as unknown
    return typeof frame === 'object' && frame !== null && typeof (frame as Frame).event === 'string' ? (frame as Frame) : undefined
  } catch {
    return undefined
  }
}

/**
 * Inertia's `live` option for `startInertiaClient()`: one socket per tab,
 * opened by the first live prop, channels reference-counted by wire name.
 */
export function liveTransport(options: GurenLiveOptions = {}): LiveOptions {
  const url = options.url ?? '/broadcasting/socket'
  const createSocket = options.webSocketFactory ?? ((target: string) => new WebSocket(target))
  const idleTimeout = options.idleTimeout ?? DEFAULT_IDLE_TIMEOUT

  const handlers = new Map<string, Set<LiveEventHandler>>()
  const channelCounts = new Map<string, number>()
  const statusListeners = new Set<(connected: boolean) => void>()
  const warned = new Set<string>()

  let socket: WebSocket | undefined
  let socketId: string | null = null
  let connected = false
  let reported = false
  let failedAttempts = 0
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const queue: { action: 'subscribe' | 'unsubscribe'; channel: string }[] = []
  let outstanding = 0
  /** Answers still owed for the subscriptions a fresh socket replays; `true` is reported once none is. */
  let replayOwed = 0

  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return
    warned.add(key)
    console.warn(message)
  }

  const report = (value: boolean): void => {
    if (reported === value) return
    reported = value
    for (const listener of statusListeners) listener(value)
  }

  const flush = (): void => {
    while (connected && socket && outstanding < MAX_OUTSTANDING && queue.length > 0) {
      const message = queue.shift()!
      outstanding += 1
      socket.send(JSON.stringify(message))
    }
  }

  const send = (action: 'subscribe' | 'unsubscribe', channel: string): void => {
    if (!connected) return
    queue.push({ action, channel })
    flush()
  }

  const onConnected = (data: unknown): void => {
    const announced = (data ?? {}) as { socketId?: unknown }
    socketId = typeof announced.socketId === 'string' ? announced.socketId : null
    connected = true
    failedAttempts = 0
    queue.length = 0
    outstanding = 0
    replayOwed = channelCounts.size
    for (const channel of channelCounts.keys()) queue.push({ action: 'subscribe', channel })
    flush()
    if (replayOwed === 0) report(true)
  }

  const onSubscription = (data: unknown): void => {
    outstanding = Math.max(0, outstanding - 1)
    const answer = (data ?? {}) as { channel?: unknown; authorized?: unknown }
    if (answer.authorized === false && typeof answer.channel === 'string') {
      warnOnce(`refused:${answer.channel}`, `The server refused the live channel "${answer.channel}"; props listening on it will not refresh.`)
    }
    if (replayOwed > 0) {
      replayOwed -= 1
      if (replayOwed === 0) report(true)
    }
    flush()
  }

  const onEvent = (frame: Frame): void => {
    if (frame.channel === undefined) {
      warnOnce('no-channel', `"${frame.event}" arrived without a channel, so no live prop can be refreshed by it; live props need @guren/server 2.36 or later.`)
      return
    }
    const listeners = handlers.get(`${frame.channel}::${frame.event}`)
    if (!listeners) return
    const payload = withoutEnvelope(frame.data)
    for (const handler of listeners) handler(payload)
  }

  const scheduleReconnect = (): void => {
    if (stopped || channelCounts.size === 0 || reconnectTimer) return
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      warnOnce('gave-up', `Could not open ${url} after ${MAX_FAILED_ATTEMPTS} attempts; live props stay as rendered. Serve the app with Application.listen() on Bun and mount broadcast.webSocketMiddleware() there.`)
      return
    }
    const delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * 2 ** Math.max(0, failedAttempts - 1))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      open()
    }, delay)
  }

  const open = (): void => {
    if (socket || stopped) return
    let current: WebSocket
    try {
      current = createSocket(socketUrl(url))
    } catch (error) {
      failedAttempts += 1
      warnOnce('open-failed', `Could not open ${url}: ${String(error)}`)
      scheduleReconnect()
      return
    }
    socket = current
    let sawConnected = false
    current.addEventListener('message', (message) => {
      if (socket !== current) return
      const frame = parseFrame((message as MessageEvent).data)
      if (!frame) return
      if (frame.event === 'connected') {
        sawConnected = true
        onConnected(frame.data)
      } else if (frame.event === 'subscription') onSubscription(frame.data)
      else onEvent(frame)
    })
    current.addEventListener('close', () => {
      if (socket !== current) return
      socket = undefined
      socketId = null
      connected = false
      if (!sawConnected) failedAttempts += 1
      if (channelCounts.size > 0) report(false)
      scheduleReconnect()
    })
  }

  const closeIdle = (): void => {
    idleTimer = undefined
    if (channelCounts.size > 0 || !socket) return
    const current = socket
    socket = undefined
    socketId = null
    connected = false
    current.close()
  }

  const acquire = (channel: string): void => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    const count = channelCounts.get(channel) ?? 0
    channelCounts.set(channel, count + 1)
    if (count > 0) return
    if (socket) send('subscribe', channel)
    else open()
  }

  const release = (channel: string): void => {
    const count = channelCounts.get(channel) ?? 0
    if (count > 1) {
      channelCounts.set(channel, count - 1)
      return
    }
    channelCounts.delete(channel)
    send('unsubscribe', channel)
    if (channelCounts.size === 0 && !idleTimer) idleTimer = setTimeout(closeIdle, idleTimeout)
  }

  const transport: LiveTransport = {
    subscribe(channel, event, handler) {
      const wire = liveWireName(channel)
      if (wire === undefined) {
        warnOnce(`type:${channel.type}`, `Guren has no ${channel.type} channels; the live prop listening on "${channel.name}" will not refresh.`)
        return () => {}
      }
      const key = `${wire}::${event}`
      const set = handlers.get(key) ?? new Set()
      set.add(handler)
      handlers.set(key, set)
      acquire(wire)
      let released = false
      return () => {
        if (released) return
        released = true
        set.delete(handler)
        if (set.size === 0) handlers.delete(key)
        release(wire)
      }
    },
    socketId: () => socketId,
    onStatusChange(callback) {
      statusListeners.add(callback)
      return () => {
        statusListeners.delete(callback)
      }
    },
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      stopped = true
      socket?.close()
    })
    // A page restored from the back/forward cache keeps its subscriptions but not its socket.
    window.addEventListener('pageshow', (event) => {
      if (!(event as PageTransitionEvent).persisted) return
      stopped = false
      failedAttempts = 0
      if (channelCounts.size > 0) open()
    })
  }

  return {
    transport,
    ...(options.throttle !== undefined ? { throttle: options.throttle } : {}),
    ...(options.pauseWhenHidden !== undefined ? { pauseWhenHidden: options.pauseWhenHidden } : {}),
  }
}
