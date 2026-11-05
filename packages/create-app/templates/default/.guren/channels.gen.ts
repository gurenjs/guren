// Generated from app — DO NOT EDIT
// Run `guren codegen` to regenerate.

export const channelPatterns = [
  // No channels found
] as const

export type ChannelPattern = typeof channelPatterns[number]
export type ChannelName =
  never

/**
 * Generated channel -> event contract map.
 * Payloads are read from each event's broadcastWith() or the literal a broadcast passes; a value the reader cannot type is unknown.
 */
export type ChannelEvents =
Record<string, Record<string, unknown>>

/**
 * Runtime manifest of detected channel patterns and event names.
 */
export const channelEventManifest = {
  // No channel events found
} as const
