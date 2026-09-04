import type { Notifiable } from './types'

/**
 * The stable type name of a notifiable. Channels must use this rather than
 * `constructor.name`: one rebuilt from a queue payload carries its original
 * name in `notifiableType` and has a plain object as its constructor.
 */
export function resolveNotifiableType(notifiable: Notifiable): string {
  return notifiable.notifiableType ?? notifiable.constructor?.name ?? 'Unknown'
}
