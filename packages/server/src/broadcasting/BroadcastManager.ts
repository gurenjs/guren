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
  BroadcastEvent,
} from './types'
import { Channel, PrivateChannel, PresenceChannel } from './channels'
import { MemoryDriver } from './drivers'
import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import { parseRequestPayload } from '../http/request'

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
      // No registration means public access
      return true
    }

    if (registration.type === 'presence') {
      const presenceAuth = registration.authorizer as PresenceChannelAuthorizer
      return await presenceAuth(channelName, user)
    }

    return await (registration.authorizer as ChannelAuthorizer)(channelName, user)
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
            userId: undefined,
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

      // Authorize each channel
      const results: Record<string, unknown> = {}

      for (const ch of channels) {
        const authResult = await this.authorize(ch, user)

        if (authResult === false || authResult === null) {
          results[ch] = { authorized: false }
        } else if (authResult === true) {
          results[ch] = { authorized: true }
        } else {
          // Presence channel - return member info
          results[ch] = {
            authorized: true,
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
   * Generate a unique client ID.
   */
  protected generateClientId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 10)
    return `sse_${timestamp}${random}`
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
 */
export function createBroadcastManager(
  options?: BroadcastManagerOptions
): BroadcastManager {
  return new BroadcastManager(options)
}
