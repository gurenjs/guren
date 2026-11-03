/**
 * The one reading of a broadcastable event (RFC 0037 §1): which name and which
 * channels it is broadcast as. `BroadcastManager.broadcastEvent()` sends with it
 * and `live()` subscribes with it, so a live prop cannot listen for a name the
 * sender never uses.
 */
import { resolveEventName } from '../events/Event'
import type { BroadcastableEvent } from './types'

/** An event as `live()` and `broadcastEvent()` read it. `eventName` is `Event`'s own getter. */
export type BroadcastTarget = Pick<BroadcastableEvent, 'broadcastOn' | 'broadcastAs'> & {
  readonly eventName?: string
}

/** `broadcastAs()`, else the event's `eventName`, else its class name. */
export function broadcastNameOf(event: BroadcastTarget): string {
  const name = event.broadcastAs?.() ?? event.eventName ?? classEventName(event)
  if (typeof name !== 'string' || name === '') {
    throw new Error(
      'A broadcast event needs a name: define broadcastAs(), extend Event, or construct it from a class.',
    )
  }
  return name
}

/** The wire names `broadcastOn()` returns, prefix included, verbatim. */
export function broadcastChannelsOf(event: BroadcastTarget): string[] {
  const channels = event.broadcastOn()
  if (!Array.isArray(channels) || channels.some((channel) => typeof channel !== 'string')) {
    throw new Error(`${describe(event)}.broadcastOn() must return an array of channel names.`)
  }
  return channels
}

function classEventName(event: object): string | undefined {
  const ctor = event.constructor as { name: string; eventName?: string } | undefined
  return ctor && ctor !== Object ? resolveEventName(ctor) : undefined
}

function describe(event: object): string {
  const ctor = event.constructor as { name?: string } | undefined
  return ctor && ctor !== Object && ctor.name ? ctor.name : 'The event'
}
