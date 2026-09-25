import type {
  BroadcastDriver,
  BroadcastDriverFactory,
  BroadcastManagerOptions,
  ChannelAuthorizer,
  PresenceChannelAuthorizer,
  ChannelRegistration,
  SSEMiddlewareOptions,
  WebSocketMiddlewareOptions,
  AuthMiddlewareOptions,
  SSEClient,
  WebSocketClient,
  BroadcastEvent,
  PresenceMember,
} from './types'
import { Channel, PrivateChannel, PresenceChannel } from './channels'
import { MemoryDriver } from './drivers'
import { claimHotDisposable, isHotReloadRuntime } from '../hot-reload/hot-disposables'
import { getAuthContext } from '../auth/context'
import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import { webSocketOriginCheck } from '../http/middleware/websocket-origin'
import { asRecord, parseRequestPayload } from '../http/request'
import { randomHex } from '../encryption/Random'
import { ambientBinding, bindAmbient } from '../http/default-application'
import { warnDeprecatedGetter, warnDeprecatedSetter } from '../support/deprecate'

/**
 * Best-effort identity for the user behind a connection: `getUser` is
 * application-supplied, so this reads the conventional fields and gives up
 * otherwise. `undefined` marks the stream unowned and therefore attachable, so
 * a stream opened before sign-in still works for authorize-after-login; the
 * ownership check is defence in depth behind unguessable client ids.
 */
function resolveClientUserId(user: unknown): string | number | undefined {
  if (typeof user !== 'object' || user === null) return undefined
  const candidate = user as { id?: unknown; sub?: unknown; userId?: unknown }
  for (const value of [candidate.id, candidate.sub, candidate.userId]) {
    if (typeof value === 'string' || typeof value === 'number') return value
  }
  return undefined
}

/**
 * The user a connection or auth request is authorized as: the app's `getUser`,
 * else the session user from the auth context. A guest is `undefined` either
 * way, which is what an unowned stream and a refused private channel key on.
 */
async function resolveRequestUser(
  ctx: Context,
  getUser: ((ctx: unknown) => unknown | Promise<unknown>) | undefined,
): Promise<unknown> {
  if (getUser) return getUser(ctx)
  return (await getAuthContext(ctx)?.user()) ?? undefined
}

/** The channels a connection asks for up front, as `?channels=a,b`, each once. */
function requestedChannels(ctx: Context): string[] {
  const channels = (ctx.req.query('channels') ?? '').split(',').map((value) => value.trim())
  return [...new Set(channels.filter(Boolean))]
}

/**
 * Whether the request came through a server that can upgrade it: `{ server }`
 * from `Application.listen()`, or the server itself when an app passes
 * `app.fetch` to `Bun.serve`. Mirrors `getBunServer()`, which cannot be asked:
 * `hono/bun` reads the `Bun` global at load, and this check is what answers 501 off Bun.
 */
function canUpgrade(ctx: Context): boolean {
  const env = ctx.env as Record<string, unknown> | undefined
  if (typeof env !== 'object' || env === null) return false
  const server = ('server' in env ? env.server : env) as { upgrade?: unknown } | undefined
  return typeof server?.upgrade === 'function'
}

// The protocol's messages are under 100 bytes; Bun admits 16 MB frames by default.
const MAX_WEBSOCKET_MESSAGE_LENGTH = 4096

// Each queued message may run an authorizer against the database, and nothing
// rate-limits frames once the socket is open.
const MAX_PENDING_WEBSOCKET_MESSAGES = 32

interface WebSocketClientMessage {
  action: 'subscribe' | 'unsubscribe'
  channel: string
}

function parseWebSocketClientMessage(data: unknown): WebSocketClientMessage | undefined {
  if (typeof data !== 'string' || data.length > MAX_WEBSOCKET_MESSAGE_LENGTH) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }

  const { action, channel } = asRecord(parsed)
  if ((action !== 'subscribe' && action !== 'unsubscribe') || typeof channel !== 'string' || channel === '') {
    return undefined
  }
  return { action, channel }
}

type ChannelAuthResult =
  | { authorized: false }
  | { authorized: true; subscribed: boolean; member?: PresenceMember }

/** Broadcast manager for real-time event broadcasting. */
export class BroadcastManager {
  protected defaultDriver: string = 'memory'

  protected driverFactories: Map<string, BroadcastDriverFactory> = new Map()

  protected resolvedDrivers: Map<string, BroadcastDriver> = new Map()

  protected channelRegistrations: ChannelRegistration[] = []

  protected sseClients: Map<string, SSEClient> = new Map()

  protected wsClients: Map<string, WebSocketClient> = new Map()

  /**
   * Driver-level unsubscribe functions, per client id and channel: the only
   * handle on the subscription `driver().subscribe()` opened. Dropping it
   * leaves the driver fanning out to a client that has already gone — and on
   * Redis, keeps that channel's SUBSCRIBE open for as long as the process lives.
   */
  protected driverSubscriptions: Map<string, Map<string, () => void>> = new Map()

  constructor(options: BroadcastManagerOptions = {}) {
    if (options.default) {
      this.defaultDriver = options.default
    }

    if (options.drivers) {
      for (const [name, factory] of Object.entries(options.drivers)) {
        this.registerDriver(name, factory)
      }
    }

    if (!this.driverFactories.has('memory')) {
      this.registerDriver('memory', () => new MemoryDriver())
    }
  }

  registerDriver(name: string, factory: BroadcastDriverFactory): this {
    this.driverFactories.set(name, factory)
    return this
  }

  driver(name?: string): BroadcastDriver {
    const driverName = name ?? this.defaultDriver

    const resolved = this.resolvedDrivers.get(driverName)
    if (resolved) {
      return resolved
    }

    const factory = this.driverFactories.get(driverName)
    if (!factory) {
      throw new Error(`Broadcast driver "${driverName}" not found`)
    }

    const driver = factory()
    this.resolvedDrivers.set(driverName, driver)
    return driver
  }

  channel(pattern: string, authorizer: ChannelAuthorizer): this {
    this.channelRegistrations.push({
      pattern,
      type: 'public',
      authorizer,
    })
    return this
  }

  privateChannel(pattern: string, authorizer: ChannelAuthorizer): this {
    this.channelRegistrations.push({
      pattern: PrivateChannel.normalize(pattern),
      type: 'private',
      authorizer,
    })
    return this
  }

  presenceChannel(
    pattern: string,
    authorizer: PresenceChannelAuthorizer
  ): this {
    this.channelRegistrations.push({
      pattern: PresenceChannel.normalize(pattern),
      type: 'presence',
      authorizer,
    })
    return this
  }

  async broadcast(
    channelName: string,
    event: string,
    data: unknown
  ): Promise<void> {
    await this.driver().publish(channelName, event, data)
  }

  toChannel(name: string): Channel {
    return new Channel(name, this.driver())
  }

  toPrivate(name: string): PrivateChannel {
    return new PrivateChannel(name, this.driver())
  }

  toPresence(name: string): PresenceChannel {
    return new PresenceChannel(name, this.driver())
  }

  async authorize(
    channelName: string,
    user: unknown
  ): Promise<boolean | { id: string | number; info?: Record<string, unknown> } | null> {
    const registration = this.findChannelRegistration(channelName)

    if (!registration) {
      // Unregistered channels are public, but private-/presence- prefixed names
      // deny: a typo in registration would otherwise expose a private channel.
      return !(channelName.startsWith('private-') || channelName.startsWith('presence-'))
    }

    // Callers read anything that is not `false`/`null` as authorized, so an
    // authorizer with an implicit-`undefined` return path must deny here.
    if (registration.type === 'presence') {
      const presenceAuth = registration.authorizer as PresenceChannelAuthorizer
      const member = await presenceAuth(channelName, user)
      return typeof member === 'object' && member !== null ? member : false
    }

    return await (registration.authorizer as ChannelAuthorizer)(channelName, user) === true
  }

  private async filterAuthorizedChannels(channels: string[], user: unknown): Promise<string[]> {
    const authorized: string[] = []
    for (const channelName of channels) {
      const authResult = await this.authorize(channelName, user)
      if (authResult !== false && authResult !== null) {
        authorized.push(channelName)
      }
    }
    return authorized
  }

  protected findChannelRegistration(
    channelName: string
  ): ChannelRegistration | undefined {
    return this.channelRegistrations.find((reg) =>
      this.matchPattern(reg.pattern, channelName)
    )
  }

  protected matchPattern(pattern: string, channelName: string): boolean {
    const regexPattern = pattern
      .replace(/\{[^}]+\}/g, '[^.]+')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^.]+')

    const regex = new RegExp(`^${regexPattern}$`)
    return regex.test(channelName)
  }

  sseMiddleware(options: SSEMiddlewareOptions = {}): Middleware {
    const pingInterval = options.pingInterval ?? 30000
    const retry = options.retry ?? 3000

    return async (ctx: Context) => {
      const clientId = this.generateClientId()
      const encoder = new TextEncoder()

      // Channels requested up front (?channels=a,b) are authorized and
      // subscribed before the stream starts, so a plain EventSource works.
      const user = await resolveRequestUser(ctx, options.getUser)
      const authorizedChannels = await this.filterAuthorizedChannels(requestedChannels(ctx), user)

      // Resolved out here, not inside `start()`: the client object outlives this
      // handler, so reading `user` in there would retain the whole user record
      // for the life of the connection. Only the scalar is needed.
      const clientUserId = resolveClientUserId(user)

      let controller: ReadableStreamDefaultController<Uint8Array> | null = null
      let client: SSEClient | null = null
      let pingTimer: ReturnType<typeof setInterval> | null = null

      const sendRaw = (message: string) => {
        if (!controller) return
        controller.enqueue(encoder.encode(message))
      }

      const cleanup = () => {
        if (pingTimer) {
          clearInterval(pingTimer)
          pingTimer = null
        }

        if (client) {
          this.releaseDriverSubscriptions(client.id)
          this.sseClients.delete(client.id)
          client = null
        }

        if (controller) {
          try {
            controller.close()
          } catch {
            // Ignore close errors
          }
          controller = null
        }
      }

      const stream = new ReadableStream<Uint8Array>({
        start: (streamController) => {
          controller = streamController

          client = {
            id: clientId,
            // So `POST /broadcasting/auth` can refuse to attach channels to
            // someone else's stream.
            userId: clientUserId,
            channels: new Set(),
            send: (event: string, data: unknown) => {
              const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
              sendRaw(message)
            },
            close: cleanup,
          }

          this.sseClients.set(clientId, client)

          sendRaw(`retry: ${retry}\n\n`)

          // The client needs its id to authorize private channels via
          // POST /broadcasting/auth { clientId, channel }.
          client.send('connected', { clientId, channels: authorizedChannels })

          for (const channelName of authorizedChannels) {
            this.subscribeClient(clientId, channelName)
          }

          pingTimer = setInterval(() => {
            try {
              client?.send('ping', { time: Date.now() })
            } catch {
              cleanup()
            }
          }, pingInterval)
        },
        cancel: () => {
          cleanup()
        },
      })

      ctx.req.raw.signal.addEventListener('abort', cleanup, { once: true })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    }
  }

  /**
   * A route that upgrades to a WebSocket carrying broadcast events, the socket
   * counterpart of `sseMiddleware()`; it needs `Application.listen()` on Bun.
   * Frames are JSON. The server sends `{ event, data }`, first `connected` with
   * `{ clientId, channels }`; the client sends `{ action: 'subscribe' | 'unsubscribe',
   * channel }`, answered by a `subscription` event, and anything else is ignored.
   */
  webSocketMiddleware(options: WebSocketMiddlewareOptions = {}): Middleware {
    const isAllowedOrigin = webSocketOriginCheck(options.allowedOrigins)

    return async (ctx: Context) => {
      if (!isAllowedOrigin(ctx)) {
        return ctx.json({ message: 'Forbidden: cross-origin WebSocket upgrade' }, 403)
      }

      if (ctx.req.header('upgrade')?.toLowerCase() !== 'websocket') {
        return ctx.json({ message: 'Expected a WebSocket upgrade request' }, 426, { Upgrade: 'websocket' })
      }

      if (!canUpgrade(ctx)) {
        return ctx.json(
          { message: 'This runtime cannot upgrade to a WebSocket. Serve the app with Application.listen() on Bun.' },
          501,
        )
      }

      // Checked before `getUser` and the authorizers run, which a request that
      // cannot be upgraded should not cost.
      if (!ctx.req.header('sec-websocket-key')) {
        return ctx.json({ message: 'Invalid WebSocket handshake' }, 400)
      }

      // Held for the socket's lifetime, unlike in `sseMiddleware()`: every later
      // `subscribe` message is authorized against this same user.
      const user = await resolveRequestUser(ctx, options.getUser)
      const authorizedChannels = await this.filterAuthorizedChannels(requestedChannels(ctx), user)
      const userId = resolveClientUserId(user)
      let clientId: string | undefined
      let handled: Promise<void> = Promise.resolve()
      let pending = 0

      const { upgradeWebSocket } = await import('hono/bun')
      const upgrade = upgradeWebSocket(() => ({
        onOpen: (_event, ws) => {
          const send = (event: string, data: unknown) => ws.send(JSON.stringify({ event, data }))
          clientId = this.registerWebSocketClient({ userId, send, close: () => ws.close() })
          send('connected', { clientId, channels: authorizedChannels })
          for (const channelName of authorizedChannels) {
            this.subscribeWebSocketClient(clientId, channelName)
          }
        },
        onMessage: (event, ws) => {
          const message = parseWebSocketClientMessage(event.data)
          const id = clientId
          if (!id || !message) return
          if (pending >= MAX_PENDING_WEBSOCKET_MESSAGES) {
            ws.close(1008, 'Too many pending messages')
            return
          }
          // In arrival order, so a `subscribe` still awaiting its authorizer
          // cannot land after an `unsubscribe` sent behind it. Nothing awaits
          // this handler, so a rejection must be caught here.
          pending += 1
          handled = handled
            .then(() => this.handleWebSocketMessage(id, message, user))
            .catch((error: unknown) => {
              console.error('Error handling broadcast WebSocket message:', error)
            })
            .finally(() => {
              pending -= 1
            })
        },
        onClose: () => {
          if (clientId) this.removeWebSocketClient(clientId)
        },
      }))

      // No response means Bun refused the handshake headers.
      return (await upgrade(ctx, async () => {})) ?? ctx.json({ message: 'Invalid WebSocket handshake' }, 400)
    }
  }

  private async handleWebSocketMessage(
    clientId: string,
    message: WebSocketClientMessage,
    user: unknown,
  ): Promise<void> {
    const client = this.wsClients.get(clientId)
    if (!client) return
    const { channel } = message

    if (message.action === 'unsubscribe') {
      this.unsubscribeWebSocketClient(clientId, channel)
      await client.send('subscription', { channel, subscribed: false })
      return
    }

    const result = await this.authorizeAndAttach(channel, user, clientId).catch((error: unknown) => {
      console.error(`Error authorizing broadcast channel "${channel}":`, error)
      return { authorized: false } as const
    })
    await client.send('subscription', { channel, ...result })
  }

  /** The one answer `POST /broadcasting/auth` and a socket's `subscribe` both give. */
  private async authorizeAndAttach(channel: string, user: unknown, clientId?: string): Promise<ChannelAuthResult> {
    const authResult = await this.authorize(channel, user)
    if (authResult === false || authResult === null) return { authorized: false }

    // Ids carry their transport's prefix, so at most one of the two matches.
    const subscribed =
      clientId !== undefined && (this.subscribeClient(clientId, channel) || this.subscribeWebSocketClient(clientId, channel))
    return authResult === true ? { authorized: true, subscribed } : { authorized: true, subscribed, member: authResult }
  }

  authMiddleware(options: AuthMiddlewareOptions = {}): Middleware {
    return async (ctx: Context) => {
      const user = await resolveRequestUser(ctx, options.getUser)

      const payload = await parseRequestPayload(ctx)
      const channel = typeof payload.channel === 'string' ? payload.channel : undefined
      const channels = Array.isArray(payload.channels)
        ? payload.channels.filter((value): value is string => typeof value === 'string')
        : typeof payload.channels === 'string'
          ? [payload.channels]
          : channel
            ? [channel]
            : []

      if (channels.length === 0) {
        return ctx.json({ error: 'No channel specified' }, 400)
      }

      // With a clientId (SSE stream or WebSocket) in the payload, also subscribe
      // the client so authorized events actually flow.
      const clientId = typeof payload.clientId === 'string' ? payload.clientId : undefined
      const results: Record<string, ChannelAuthResult> = {}

      // Authorization answers "may this user read the channel", not "may they
      // attach it to *that* stream": without this check, a request naming
      // someone else's clientId pushes events into that person's stream. An
      // unowned stream (opened before sign-in) stays attachable.
      const requesterId = resolveClientUserId(user)
      const target = clientId ? (this.sseClients.get(clientId) ?? this.wsClients.get(clientId)) : undefined
      const attachTo =
        target && (target.userId === undefined || target.userId === requesterId) ? target : undefined

      for (const ch of channels) {
        results[ch] = await this.authorizeAndAttach(ch, user, attachTo?.id)
      }

      return ctx.json(results)
    }
  }

  subscribeClient(clientId: string, channel: string): boolean {
    const client = this.sseClients.get(clientId)
    if (!client) return false

    client.channels.add(channel)
    this.openDriverSubscription(clientId, channel, (event) => {
      if (client.channels.has(channel)) {
        client.send(event.event, event.data)
      }
    })

    return true
  }

  /**
   * Open one driver subscription for a client/channel pair, keeping its
   * unsubscribe handle so the pair can be torn down later.
   *
   * A pair that is already subscribed is left alone: a second `subscribe`
   * would register a second callback and deliver every event twice.
   */
  protected openDriverSubscription(
    clientId: string,
    channel: string,
    callback: (event: BroadcastEvent) => void
  ): void {
    let subscriptions = this.driverSubscriptions.get(clientId)
    if (!subscriptions) {
      subscriptions = new Map()
      this.driverSubscriptions.set(clientId, subscriptions)
    }
    if (subscriptions.has(channel)) return

    subscriptions.set(channel, this.driver().subscribe(channel, callback))
  }

  /**
   * Close the driver subscription for one client/channel pair.
   */
  protected closeDriverSubscription(clientId: string, channel: string): void {
    const subscriptions = this.driverSubscriptions.get(clientId)
    const unsubscribe = subscriptions?.get(channel)
    if (!subscriptions || !unsubscribe) return

    subscriptions.delete(channel)
    if (subscriptions.size === 0) {
      this.driverSubscriptions.delete(clientId)
    }
    unsubscribe()
  }

  /**
   * Close every driver subscription a client holds.
   */
  protected releaseDriverSubscriptions(clientId: string): void {
    const subscriptions = this.driverSubscriptions.get(clientId)
    if (!subscriptions) return

    this.driverSubscriptions.delete(clientId)
    for (const unsubscribe of subscriptions.values()) {
      unsubscribe()
    }
  }

  /** Returns the generated client ID. */
  registerWebSocketClient(client: Omit<WebSocketClient, 'id' | 'channels'> & { userId?: string | number }): string {
    const clientId = this.generateClientId('ws')
    this.wsClients.set(clientId, {
      ...client,
      id: clientId,
      channels: new Set(),
    })
    return clientId
  }

  removeWebSocketClient(clientId: string): boolean {
    const client = this.wsClients.get(clientId)
    if (!client) return false
    this.releaseDriverSubscriptions(clientId)
    this.wsClients.delete(clientId)
    client.close()
    return true
  }

  /**
   * Subscribes without authorizing, like `subscribeClient()`: for a channel the
   * server chose. Put a channel the client named through `authorize()` first,
   * as `webSocketMiddleware()` and `authMiddleware()` do.
   */
  subscribeWebSocketClient(clientId: string, channel: string): boolean {
    const client = this.wsClients.get(clientId)
    if (!client) return false

    client.channels.add(channel)
    this.openDriverSubscription(clientId, channel, async (event) => {
      if (client.channels.has(channel)) {
        await client.send(event.event, event.data)
      }
    })

    return true
  }

  unsubscribeWebSocketClient(clientId: string, channel: string): boolean {
    const client = this.wsClients.get(clientId)
    if (!client) return false

    client.channels.delete(channel)
    this.closeDriverSubscription(clientId, channel)
    return true
  }

  getWebSocketClient(clientId: string): WebSocketClient | undefined {
    return this.wsClients.get(clientId)
  }

  getWebSocketClients(): WebSocketClient[] {
    return Array.from(this.wsClients.values())
  }

  unsubscribeClient(clientId: string, channel: string): boolean {
    const client = this.sseClients.get(clientId)
    if (!client) return false

    client.channels.delete(channel)
    this.closeDriverSubscription(clientId, channel)
    return true
  }

  getClient(clientId: string): SSEClient | undefined {
    return this.sseClients.get(clientId)
  }

  getClients(): SSEClient[] {
    return Array.from(this.sseClients.values())
  }

  getChannelClients(channel: string): SSEClient[] {
    return this.getClients().filter((client) => client.channels.has(channel))
  }

  /**
   * Close every SSE and WebSocket connection this manager holds. Each SSE stream
   * owns a ping timer that is only cleared on stream cancel or request abort, and
   * `Bun.serve().stop()` waits for in-flight requests while an SSE response never
   * finishes — so on a hot reload the timers would go on pinging. Both lists are
   * snapshots: a `close()` reaching another client would drop it mid-iteration.
   */
  disconnectAll(): void {
    for (const client of this.getClients()) {
      try {
        client.close()
      } catch {
        // A stream torn down from the other end is already what we wanted.
      }
    }

    for (const client of this.getWebSocketClients()) {
      try {
        this.removeWebSocketClient(client.id)
      } catch {
        // Removal releases the driver subscriptions before closing the socket.
      }
    }
  }

  protected generateClientId(prefix: 'sse' | 'ws' = 'sse'): string {
    // Unguessable, not merely unique: `POST /broadcasting/auth` takes a
    // `clientId` from the body, so a predictable id lets anyone attach channels
    // to another connection's stream.
    return `${prefix}_${randomHex(16)}`
  }
}

let globalBroadcastManager: BroadcastManager | null = null

/**
 * @deprecated since 2.23.0, removed in 3.0.0 (RFC 0023). Bind the manager on the
 * app's container instead — `BroadcastServiceProvider` already does, and a
 * provider of your own reaches it as `this.container.instance('broadcast', m)`.
 */
export function setBroadcastManager(manager: BroadcastManager): void {
  warnDeprecatedSetter('setBroadcastManager')
  globalBroadcastManager = bindAmbient('broadcast', manager) ? null : manager
}

/**
 * @deprecated since 2.23.0, removed in 3.0.0 (RFC 0023). Use
 * `this.make('broadcast')` in a controller, job or command, or
 * `defaultContainer().make('broadcast')`.
 */
export function getBroadcastManager(): BroadcastManager {
  warnDeprecatedGetter('getBroadcastManager')
  const manager = ambientBinding('broadcast') ?? globalBroadcastManager
  if (!manager) {
    throw new Error('BroadcastManager not initialized. Register BroadcastServiceProvider, or call setBroadcastManager() first.')
  }
  return manager
}

/**
 * Under `bun --hot`, the manager this one replaces has its SSE connections
 * closed first, so their ping timers stop with it. Claimed from the factory
 * rather than the constructor because frame 2 of the stack must be the caller's
 * provider; a bare `new BroadcastManager()` is left alone.
 */
export function createBroadcastManager(
  options?: BroadcastManagerOptions
): BroadcastManager {
  const manager = new BroadcastManager(options)

  claimHotDisposable(
    'broadcast-manager',
    isHotReloadRuntime() ? new Error().stack : undefined,
    options?.default ?? 'memory',
    () => manager.disconnectAll(),
  )

  return manager
}
