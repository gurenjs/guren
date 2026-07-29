import type { Notifiable } from './types'

/**
 * Resolve the type name a notifiable is persisted and queued under.
 *
 * Prefers an explicit `notifiableType` over the constructor name, which a
 * bundler may mangle and which is lost once the notifiable is rebuilt from a
 * queued payload. Mirrors `resolveJobName()` on the queue side.
 */
export function resolveNotifiableType(notifiable: Notifiable): string {
  return notifiable.notifiableType ?? notifiable.constructor?.name ?? 'Unknown'
}
