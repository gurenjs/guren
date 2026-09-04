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
import { randomHex } from '../encryption/Random'

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

/** Broadcast manager for real-time event broadcasting. */
export class BroadcastManager {
  protected defaultDriver: string = 'memory'

  protected driverFactories: Map<string, BroadcastDriverFactory> = new Map()

  protected resolvedDrivers: Map<string, BroadcastDriver> = new Map()

  protected channelRegistrations: ChannelRegistration[] = []

  protected sseClients: Map<string, SSEClient> = new Map()

  protected wsClients: Map<string, WebSocketClient> = new Map()

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
      const manager = this

      // Channels requested up front (?channels=a,b) are authorized and
      // subscribed before the stream starts, so a plain EventSource works.
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

          manager.sseClients.set(clientId, client)

          sendRaw(`retry: ${retry}\n\n`)

          // The client needs its id to authorize private channels via
          // POST /broadcasting/auth { clientId, channel }.
          client.send('connected', { clientId, channels: authorizedChannels })

          for (const channelName of authorizedChannels) {
            manager.subscribeClient(clientId, channelName)
          }

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

  authMiddleware(options: AuthMiddlewareOptions = {}): Middleware {
    return async (ctx: Context) => {
      const getUser = options.getUser ?? ((c) => (c as any).auth?.user)
      const user = await getUser(ctx)

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

      // With the SSE clientId in the payload, also subscribe the client so
      // authorized events actually flow.
      const clientId = typeof payload.clientId === 'string' ? payload.clientId : undefined
      const results: Record<string, unknown> = {}

      // Authorization answers "may this user read the channel", not "may they
      // attach it to *that* stream": without this check, a request naming
      // someone else's clientId pushes events into that person's stream. An
      // unowned stream (opened before sign-in) stays attachable.
      const requesterId = resolveClientUserId(user)
      const target = clientId ? this.sseClients.get(clientId) : undefined
      const attachTo =
        target && (target.userId === undefined || target.userId === requesterId) ? target : undefined

      for (const ch of channels) {
        const authResult = await this.authorize(ch, user)

        if (authResult === false || authResult === null) {
          results[ch] = { authorized: false }
          continue
        }

        const subscribed = attachTo ? this.subscribeClient(attachTo.id, ch) : false
        if (authResult === true) {
          results[ch] = { authorized: true, subscribed }
        } else {
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

  subscribeClient(clientId: string, channel: string): boolean {
    const client = this.sseClients.get(clientId)
    if (!client) return false

    client.channels.add(channel)

    this.driver().subscribe(channel, (event: BroadcastEvent) => {
      if (client.channels.has(channel)) {
        client.send(event.event, event.data)
      }
    })

    return true
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
    this.wsClients.delete(clientId)
    client.close()
    return true
  }

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

  unsubscribeWebSocketClient(clientId: string, channel: string): boolean {
    const client = this.wsClients.get(clientId)
    if (!client) return false

    client.channels.delete(channel)
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
   * Close every SSE connection this manager holds. Each owns a ping timer that
   * is only cleared on stream cancel or request abort, and `Bun.serve().stop()`
   * waits for in-flight requests while an SSE response never finishes — so on a
   * hot reload the timers would go on pinging. `getClients()` is a snapshot: a
   * `close()` reaching another client would drop it from a live iteration.
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

  protected generateClientId(prefix: 'sse' | 'ws' = 'sse'): string {
    // Unguessable, not merely unique: `POST /broadcasting/auth` takes a
    // `clientId` from the body, so a predictable id lets anyone attach channels
    // to another connection's stream.
    return `${prefix}_${randomHex(16)}`
  }
}

let globalBroadcastManager: BroadcastManager | null = null

export function setBroadcastManager(manager: BroadcastManager): void {
  globalBroadcastManager = manager
}

export function getBroadcastManager(): BroadcastManager {
  if (!globalBroadcastManager) {
    throw new Error('BroadcastManager not initialized. Call setBroadcastManager() first.')
  }
  return globalBroadcastManager
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
