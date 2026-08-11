import type {
  BroadcastDriver,
  BroadcastDriverFactory,
  BroadcastManagerOptions,
  ChannelAuthorizer,
  PresenceChannelAuthorizer,
  ChannelRegistration,
  SSEMiddlewareOptions,
  AuthMiddlewareOptions,
  SSEClient,
  WebSocketClient,
  BroadcastEvent,
} from './types'
import { Channel, PrivateChannel, PresenceChannel } from './channels'
import { MemoryDriver } from './drivers'
import { claimHotDisposable, isHotReloadRuntime } from '../hot-reload/hot-disposables'
import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import { parseRequestPayload } from '../http/request'

/**
 * Best-effort identity for the user behind a connection.
 *
 * `getUser` is application-supplied and returns `unknown`, so this reads the
 * conventional `id` and gives up otherwise. Giving up yields `undefined`, which
 * marks the stream unowned — the permissive direction, so a bespoke user shape
 * degrades to today's behaviour rather than silently refusing every subscribe.
 */
function resolveClientUserId(user: unknown): string | number | undefined {
  if (typeof user !== 'object' || user === null) return undefined
  const id = (user as { id?: unknown }).id
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

/**
 * Broadcast manager for real-time event broadcasting.
 *
 * @example
 * ```typescript
 * const broadcast = new BroadcastManager({
 *   default: 'memory',
 *   drivers: {
 *     memory: () => new MemoryDriver(),
 *     redis: () => new RedisDriver(redis),
 *   },
 * })
 *
 * // Register channel authorizers
 * broadcast
 *   .channel('public.*', () => true)
 *   .privateChannel('orders.{orderId}', async (channel, user) => {
 *     const orderId = channel.split('.')[1]
 *     return order.userId === user.id
 *   })
 *   .presenceChannel('chat.{roomId}', async (channel, user) => {
 *     return { id: user.id, info: { name: user.name } }
 *   })
 *
 * // Broadcast events
 * await broadcast.broadcast('notifications', 'NewMessage', { content: 'Hello!' })
 *
 * // Or use channel helpers
 * await broadcast.toChannel('notifications').broadcast('NewMessage', data)
 * await broadcast.toPrivate('orders.123').broadcast('OrderUpdated', data)
 * await broadcast.toPresence('chat.1').broadcast('UserTyping', data)
 * ```
 */
export class BroadcastManager {
  /**
   * Default driver name.
   */
  protected defaultDriver: string = 'memory'

  /**
   * Driver factories.
   */
  protected driverFactories: Map<string, BroadcastDriverFactory> = new Map()

  /**
   * Resolved drivers.
   */
  protected resolvedDrivers: Map<string, BroadcastDriver> = new Map()

  /**
   * Channel registrations.
   */
  protected channelRegistrations: ChannelRegistration[] = []

  /**
   * SSE clients.
   */
  protected sseClients: Map<string, SSEClient> = new Map()

  /**
   * WebSocket clients.
   */
  protected wsClients: Map<string, WebSocketClient> = new Map()

  constructor(options: BroadcastManagerOptions = {}) {
    if (options.default) {
      this.defaultDriver = options.default
    }

    // Register provided drivers
    if (options.drivers) {
      for (const [name, factory] of Object.entries(options.drivers)) {
        this.registerDriver(name, factory)
      }
    }

    // Always register memory driver as fallback
    if (!this.driverFactories.has('memory')) {
      this.registerDriver('memory', () => new MemoryDriver())
    }
  }

  /**
   * Register a driver factory.
   */
  registerDriver(name: string, factory: BroadcastDriverFactory): this {
    this.driverFactories.set(name, factory)
    return this
  }

  /**
   * Get a driver by name.
   */
  driver(name?: string): BroadcastDriver {
    const driverName = name ?? this.defaultDriver

    // Check resolved cache
    const resolved = this.resolvedDrivers.get(driverName)
    if (resolved) {
      return resolved
    }

    // Create from factory
    const factory = this.driverFactories.get(driverName)
    if (!factory) {
      throw new Error(`Broadcast driver "${driverName}" not found`)
    }

    const driver = factory()
    this.resolvedDrivers.set(driverName, driver)
    return driver
  }

  /**
   * Register a public channel authorizer.
   */
  channel(pattern: string, authorizer: ChannelAuthorizer): this {
    this.channelRegistrations.push({
      pattern,
      type: 'public',
      authorizer,
    })
    return this
  }

  /**
   * Register a private channel authorizer.
   */
  privateChannel(pattern: string, authorizer: ChannelAuthorizer): this {
    this.channelRegistrations.push({
      pattern: PrivateChannel.normalize(pattern),
      type: 'private',
      authorizer,
    })
    return this
  }

  /**
   * Register a presence channel authorizer.
   */
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

  /**
   * Broadcast an event to a channel.
   */
  async broadcast(
    channelName: string,
    event: string,
    data: unknown
  ): Promise<void> {
    await this.driver().publish(channelName, event, data)
  }

  /**
   * Get a public channel.
   */
  toChannel(name: string): Channel {
    return new Channel(name, this.driver())
  }

  /**
   * Get a private channel.
   */
  toPrivate(name: string): PrivateChannel {
    return new PrivateChannel(name, this.driver())
  }

  /**
   * Get a presence channel.
   */
  toPresence(name: string): PresenceChannel {
    return new PresenceChannel(name, this.driver())
  }

  /**
   * Authorize a channel for a user.
   */
  async authorize(
    channelName: string,
    user: unknown
  ): Promise<boolean | { id: string | number; info?: Record<string, unknown> } | null> {
    const registration = this.findChannelRegistration(channelName)

    if (!registration) {
      // Unregistered channels are treated as public, but names using the
      // private-/presence- prefixes default to deny — otherwise a typo in
      // channel registration would silently expose a private channel.
      return !(channelName.startsWith('private-') || channelName.startsWith('presence-'))
    }

    // Callers read anything that is not `false`/`null` as authorized, so
    // normalize here: an authorizer with an implicit-`undefined` return path
    // must deny rather than grant.
    if (registration.type === 'presence') {
      const presenceAuth = registration.authorizer as PresenceChannelAuthorizer
      const member = await presenceAuth(channelName, user)
      return typeof member === 'object' && member !== null ? member : false
    }

    return await (registration.authorizer as ChannelAuthorizer)(channelName, user) === true
  }

  /**
   * Find channel registration for a channel name.
   */
  protected findChannelRegistration(
    channelName: string
  ): ChannelRegistration | undefined {
    return this.channelRegistrations.find((reg) =>
      this.matchPattern(reg.pattern, channelName)
    )
  }

  /**
   * Match a channel name against a pattern.
   */
  protected matchPattern(pattern: string, channelName: string): boolean {
    // Convert pattern to regex
    // {param} -> [^.]+
    // * -> [^.]+
    // ** -> .+
    const regexPattern = pattern
      .replace(/\{[^}]+\}/g, '[^.]+')
      .replace(/\*\*/g, '.+')
      .replace(/\*/g, '[^.]+')

    const regex = new RegExp(`^${regexPattern}$`)
    return regex.test(channelName)
  }

  /**
   * Create SSE middleware.
   */
  sseMiddleware(options: SSEMiddlewareOptions = {}): Middleware {
    const pingInterval = options.pingInterval ?? 30000
    const retry = options.retry ?? 3000

    return async (ctx: Context) => {
      // Generate client ID
      const clientId = this.generateClientId()
      const encoder = new TextEncoder()
      const manager = this

      // Channels requested up front (?channels=a,b) are authorized against
      // the connecting user and subscribed before the stream starts, so a
      // plain EventSource works for public channels with zero extra calls.
      const requestedChannels = (ctx.req.query('channels') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const user = options.getUser ? await options.getUser(ctx) : undefined
      const authorizedChannels: string[] = []
      for (const channelName of requestedChannels) {
        const authResult = await this.authorize(channelName, user)
        if (authResult !== false && authResult !== null) {
          authorizedChannels.push(channelName)
        }
      }

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
          manager.sseClients.delete(client.id)
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
        start(streamController) {
          controller = streamController

          client = {
            id: clientId,
            // Recorded so `POST /broadcasting/auth` can refuse to attach
            // channels to a stream belonging to someone else.
            userId: resolveClientUserId(user),
            channels: new Set(),
            send: (event: string, data: unknown) => {
              const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
              sendRaw(message)
            },
            close: cleanup,
          }

          manager.sseClients.set(clientId, client)

          // Send initial retry configuration
          sendRaw(`retry: ${retry}\n\n`)

          // Tell the client its id so it can authorize private channels
          // via POST /broadcasting/auth { clientId, channel }.
          client.send('connected', { clientId, channels: authorizedChannels })

          for (const channelName of authorizedChannels) {
            manager.subscribeClient(clientId, channelName)
          }

          // Setup ping interval
          pingTimer = setInterval(() => {
            try {
              client?.send('ping', { time: Date.now() })
            } catch {
              cleanup()
            }
          }, pingInterval)
        },
        cancel() {
          cleanup()
        },
      })

      // Handle client disconnect
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
   * Create auth middleware for channel authorization.
   */
  authMiddleware(options: AuthMiddlewareOptions = {}): Middleware {
    return async (ctx: Context) => {
      // Get user from context
      const getUser = options.getUser ?? ((c) => (c as any).auth?.user)
      const user = await getUser(ctx)

      // Get channel(s) from request payload
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

      // Authorize each channel; when the payload carries the SSE clientId
      // (sent to the client in the `connected` event), also subscribe the
      // client so authorized events actually flow.
      const clientId = typeof payload.clientId === 'string' ? payload.clientId : undefined
      const results: Record<string, unknown> = {}

      // Authorization answers "may *this user* read the channel", which is not
      // the same question as "may this user attach it to *that* stream". Without
      // the second check, a request naming someone else's clientId pushes the
      // caller's own authorized events into that person's stream. A stream
      // opened before sign-in has no owner and stays attachable — its id is
      // unguessable, and refusing would break authorizing after login.
      const requesterId = resolveClientUserId(user)
      const target = clientId ? this.sseClients.get(clientId) : undefined
      const ownsTarget =
        target !== undefined && (target.userId === undefined || target.userId === requesterId)

      for (const ch of channels) {
        const authResult = await this.authorize(ch, user)

        if (authResult === false || authResult === null) {
          results[ch] = { authorized: false }
          continue
        }

        const subscribed = ownsTarget ? this.subscribeClient(clientId!, ch) : false
        if (authResult === true) {
          results[ch] = { authorized: true, subscribed }
        } else {
          // Presence channel - return member info
          results[ch] = {
            authorized: true,
            subscribed,
            member: authResult,
          }
        }
      }

      return ctx.json(results)
    }
  }

  /**
   * Subscribe a client to a channel.
   */
  subscribeClient(clientId: string, channel: string): boolean {
    const client = this.sseClients.get(clientId)
    if (!client) return false

    client.channels.add(channel)

    // Setup channel subscription
    this.driver().subscribe(channel, (event: BroadcastEvent) => {
      if (client.channels.has(channel)) {
        client.send(event.event, event.data)
      }
    })

    return true
  }

  /**
   * Register a WebSocket client and return its generated client ID.
   */
  registerWebSocketClient(client: Omit<WebSocketClient, 'id' | 'channels'> & { userId?: string | number }): string {
    const clientId = this.generateClientId('ws')
    this.wsClients.set(clientId, {
      ...client,
      id: clientId,
      channels: new Set(),
    })
    return clientId
  }

  /**
   * Remove a WebSocket client and close the underlying connection.
   */
  removeWebSocketClient(clientId: string): boolean {
    const client = this.wsClients.get(clientId)
    if (!client) return false
    this.wsClients.delete(clientId)
    client.close()
    return true
  }

  /**
   * Subscribe a WebSocket client to a channel.
   */
  subscribeWebSocketClient(clientId: string, channel: string): boolean {
    const client = this.wsClients.get(clientId)
    if (!client) return false

    client.channels.add(channel)
    this.driver().subscribe(channel, async (event: BroadcastEvent) => {
      if (client.channels.has(channel)) {
        await client.send(event.event, event.data)
      }
    })

    return true
  }

  /**
   * Unsubscribe a WebSocket client from a channel.
   */
  unsubscribeWebSocketClient(clientId: string, channel: string): boolean {
    const client = this.wsClients.get(clientId)
    if (!client) return false

    client.channels.delete(channel)
    return true
  }

  /**
   * Get a WebSocket client by ID.
   */
  getWebSocketClient(clientId: string): WebSocketClient | undefined {
    return this.wsClients.get(clientId)
  }

  /**
   * Get all WebSocket clients.
   */
  getWebSocketClients(): WebSocketClient[] {
    return Array.from(this.wsClients.values())
  }

  /**
   * Unsubscribe a client from a channel.
   */
  unsubscribeClient(clientId: string, channel: string): boolean {
    const client = this.sseClients.get(clientId)
    if (!client) return false

    client.channels.delete(channel)
    return true
  }

  /**
   * Get SSE client by ID.
   */
  getClient(clientId: string): SSEClient | undefined {
    return this.sseClients.get(clientId)
  }

  /**
   * Get all SSE clients.
   */
  getClients(): SSEClient[] {
    return Array.from(this.sseClients.values())
  }

  /**
   * Get clients subscribed to a channel.
   */
  getChannelClients(channel: string): SSEClient[] {
    return this.getClients().filter((client) => client.channels.has(channel))
  }

  /**
   * Close every SSE connection this manager is holding.
   *
   * Each connection owns a ping timer that is only cleared when the stream is
   * cancelled or the request aborts. `Bun.serve().stop()` without forcing waits
   * for in-flight requests instead of cutting them, and an SSE response never
   * finishes — so on a hot reload those connections outlive the manager, and
   * their timers go on pinging a stream nobody reads.
   *
   * `getClients()` returns a snapshot. A `Map` iterator does tolerate an entry
   * deleting itself, which is all `cleanup()` does today — but not a `close()`
   * that reaches another client, which would drop that one from the iteration
   * unvisited and leave its timer running.
   */
  disconnectAll(): void {
    for (const client of this.getClients()) {
      try {
        client.close()
      } catch {
        // A stream torn down from the other end is already what we wanted.
      }
    }
  }

  /**
   * Generate a unique client ID.
   */
  protected generateClientId(prefix: 'sse' | 'ws' = 'sse'): string {
    // Unguessable, not merely unique: `POST /broadcasting/auth` accepts a
    // `clientId` from the request body, so anyone who can predict another
    // connection's id can attach channels to that connection's stream. A
    // `Math.random()` suffix beside a `Date.now()` prefix is reconstructable.
    const random = new Uint8Array(16)
    crypto.getRandomValues(random)
    const suffix = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${prefix}_${suffix}`
  }
}

// Global instance management
let globalBroadcastManager: BroadcastManager | null = null

/**
 * Set the global broadcast manager.
 */
export function setBroadcastManager(manager: BroadcastManager): void {
  globalBroadcastManager = manager
}

/**
 * Get the global broadcast manager.
 */
export function getBroadcastManager(): BroadcastManager {
  if (!globalBroadcastManager) {
    throw new Error('BroadcastManager not initialized. Call setBroadcastManager() first.')
  }
  return globalBroadcastManager
}

/**
 * Create a broadcast manager.
 *
 * Under `bun --hot`, the manager this one replaces has its SSE connections
 * closed first, so their ping timers stop with it. Registered from the factory
 * rather than the constructor because the factory is what application code
 * calls: frame 2 of the stack is the provider that built the manager, not this
 * file. A bare `new BroadcastManager()` is left alone.
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
