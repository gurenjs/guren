import type { Event } from './Event'

/**
 * Marks a `Date` inside a queued event's fields. A driver that JSON-encodes the
 * message turns every Date into a string indistinguishable from a string field,
 * so the tag is what tells the worker which ones to revive.
 */
const DATE_TAG = '__guren_date'

/**
 * An event's own enumerable fields, one level deep: a Date nested inside an
 * object or array field survives as whatever the driver's encoding makes of it.
 */
export function encodeEventData(event: Event): Record<string, unknown> {
  const encoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    encoded[key] = value instanceof Date ? { [DATE_TAG]: value.toISOString() } : value
  }
  return encoded
}

/** The inverse of {@link encodeEventData}; a value that carries no tag is passed through. */
export function decodeEventData(data: Record<string, unknown>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const iso = readDateTag(value)
    decoded[key] = iso === undefined ? value : new Date(iso)
  }
  return decoded
}

function readDateTag(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const tagged = (value as Record<string, unknown>)[DATE_TAG]
  return typeof tagged === 'string' ? tagged : undefined
}
