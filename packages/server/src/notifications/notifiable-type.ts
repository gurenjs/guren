import type { Notifiable } from './types'

/**
 * Resolve the stable type name of a notifiable.
 *
 * Channels that record which entity a notification belongs to should use this
 * rather than reading `constructor.name` directly: a notifiable rebuilt from a
 * queue payload carries its original name in `notifiableType`, and its
 * constructor is a plain object.
 */
export function resolveNotifiableType(notifiable: Notifiable): string {
  return notifiable.notifiableType ?? notifiable.constructor?.name ?? 'Unknown'
}
