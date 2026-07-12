/**
 * Broadcast event payload.
 */
export interface BroadcastEvent {
  channel: string
  event: string
  data: unknown
  timestamp: Date
}

/**
 * Broadcast driver interface.
 */
export interface BroadcastDriver {
  /**
   * Publish an event to a channel.
   */
  publish(channel: string, event: string, data: unknown): Promise<void>

  /**
   * Subscribe to a channel.
   * Returns an unsubscribe function.
   */
  subscribe(
    channel: string,
    callback: (event: BroadcastEvent) => void
  ): () => void

  /**
   * Unsubscribe from a channel.
   */
  unsubscribe(channel: string, callback: (event: BroadcastEvent) => void): void
}

/**
 * Broadcast driver with presence support.
 */
export interface PresenceBroadcastDriver extends BroadcastDriver {
  /**
   * Get members of a presence channel.
   */
  getMembers(channel: string): PresenceMember[]

  /**
   * Add a member to a presence channel.
   */
  addMember(channel: string, member: PresenceMember): void

  /**
   * Remove a member from a presence channel.
   */
  removeMember(channel: string, memberId: string | number): void
}

/**
 * Channel authorizer function.
 */
export interface ChannelAuthorizer {
  (channelName: string, user: unknown): boolean | Promise<boolean>
}

/**
 * Presence channel authorizer function.
 * Returns member info if authorized, null otherwise.
 */
export interface PresenceChannelAuthorizer {
  (
    channelName: string,
    user: unknown
  ): PresenceMember | null | Promise<PresenceMember | null>
}

/**
 * Presence channel member.
 */
export interface PresenceMember {
  id: string | number
  info?: Record<string, unknown>
}

/**
 * SSE client connection.
 */
export interface SSEClient {
  id: string
  userId?: string | number
  channels: Set<string>
  send(event: string, data: unknown): void
  close(): void
}

/**
 * WebSocket client connection.
 */
export interface WebSocketClient {
  id: string
  userId?: string | number
  channels: Set<string>
  send(event: string, data: unknown): void | Promise<void>
  close(): void
}

/**
 * Broadcast manager options.
 */
export interface BroadcastManagerOptions {
  /**
   * Default driver name.
   */
  default?: string

  /**
   * Driver factories.
   */
  drivers?: Record<string, BroadcastDriverFactory>
}

/**
 * Broadcast driver factory.
 */
export interface BroadcastDriverFactory {
  (): BroadcastDriver
}

/**
 * Channel registration.
 */
export interface ChannelRegistration {
  pattern: string
  type: 'public' | 'private' | 'presence'
  authorizer: ChannelAuthorizer | PresenceChannelAuthorizer
}

/**
 * SSE middleware options.
 */
export interface SSEMiddlewareOptions {
  /**
   * Ping interval in milliseconds.
   */
  pingInterval?: number

  /**
   * Retry delay for SSE reconnection.
   */
  retry?: number

  /**
   * Function to get the user from the request context, used to authorize
   * channels requested via the `?channels=` query parameter.
   */
  getUser?: (ctx: unknown) => unknown | Promise<unknown>
}

/**
 * Auth middleware options.
 */
export interface AuthMiddlewareOptions {
  /**
   * Function to get user from context.
   */
  getUser?: (ctx: unknown) => unknown | Promise<unknown>
}

/**
 * Broadcasted event interface (for Event class integration).
 */
export interface BroadcastableEvent {
  /**
   * Get channels to broadcast to.
   */
  broadcastOn(): string[]

  /**
   * Get the event name for broadcasting.
   */
  broadcastAs?(): string

  /**
   * Get the data to broadcast.
   */
  broadcastWith?(): Record<string, unknown>
}
