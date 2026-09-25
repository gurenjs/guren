import type { WebSocketOriginOptions } from '../http/middleware/websocket-origin'

export interface BroadcastEvent {
  channel: string
  event: string
  data: unknown
  timestamp: Date
}

export interface BroadcastDriver {
  publish(channel: string, event: string, data: unknown): Promise<void>

  /** Returns an unsubscribe function. */
  subscribe(
    channel: string,
    callback: (event: BroadcastEvent) => void
  ): () => void

  unsubscribe(channel: string, callback: (event: BroadcastEvent) => void): void
}

export interface PresenceBroadcastDriver extends BroadcastDriver {
  getMembers(channel: string): PresenceMember[]

  addMember(channel: string, member: PresenceMember): void

  removeMember(channel: string, memberId: string | number): void
}

export interface ChannelAuthorizer {
  (channelName: string, user: unknown): boolean | Promise<boolean>
}

/** Returns member info if authorized, null otherwise. */
export interface PresenceChannelAuthorizer {
  (
    channelName: string,
    user: unknown
  ): PresenceMember | null | Promise<PresenceMember | null>
}

export interface PresenceMember {
  id: string | number
  info?: Record<string, unknown>
}

export interface SSEClient {
  id: string
  userId?: string | number
  channels: Set<string>
  send(event: string, data: unknown): void
  close(): void
}

export interface WebSocketClient {
  id: string
  userId?: string | number
  channels: Set<string>
  send(event: string, data: unknown): void | Promise<void>
  close(): void
}

export interface BroadcastManagerOptions {
  default?: string

  drivers?: Record<string, BroadcastDriverFactory>
}

export interface BroadcastDriverFactory {
  (): BroadcastDriver
}

export interface ChannelRegistration {
  pattern: string
  type: 'public' | 'private' | 'presence'
  authorizer: ChannelAuthorizer | PresenceChannelAuthorizer
}

export interface SSEMiddlewareOptions {
  /** Ping interval in milliseconds. */
  pingInterval?: number

  /** Retry delay for SSE reconnection, in milliseconds. */
  retry?: number

  /**
   * Resolves the user from the request context, which authorizes channels
   * requested via the `?channels=` query parameter. Defaults to the session
   * user from the auth context (`getAuthContext(ctx)?.user()`).
   */
  getUser?: (ctx: unknown) => unknown | Promise<unknown>
}

/** `allowedOrigins` is the `createWebSocketOriginGuard()` option; any other browser `Origin` gets 403. */
export interface WebSocketMiddlewareOptions extends WebSocketOriginOptions {
  /**
   * Resolves the user from the upgrade request. That one user authorizes the
   * `?channels=` query and every `subscribe` message for the socket's lifetime.
   * Defaults to the session user from the auth context.
   */
  getUser?: (ctx: unknown) => unknown | Promise<unknown>
}

export interface AuthMiddlewareOptions {
  /** Resolves the requesting user. Defaults to the session user from the auth context. */
  getUser?: (ctx: unknown) => unknown | Promise<unknown>
}

/** Implemented by Event classes that broadcast. */
export interface BroadcastableEvent {
  broadcastOn(): string[]

  broadcastAs?(): string

  broadcastWith?(): Record<string, unknown>
}
