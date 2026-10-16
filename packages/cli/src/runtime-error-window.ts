/**
 * A window of the runtime-error feed (RFC 0032 §4) around work this process does: the head
 * read before it, everything after it drained, and whether that is all there was. Shared by
 * `browser:doctor` and `browser:record` (RFC 0033 §4, §7), so a restart, an expired cursor or
 * dropped events read as not conclusive in both, never as zero errors.
 */

import type { RuntimeErrorQuery, RuntimeErrorResult } from './runtime-errors'

export type RuntimeErrorEvent = Extract<RuntimeErrorResult, { status: 'available' }>['events'][number]
export type RuntimeErrorRead = (origin: string, query: RuntimeErrorQuery) => Promise<RuntimeErrorResult>

export type Drained =
  | { status: 'unavailable'; reason: string }
  | { status: 'available'; sessionId: string; head: RuntimeErrorQuery; dropped: number; expired: boolean; events: RuntimeErrorEvent[] }

export interface ErrorWindow {
  status: 'conclusive' | 'inconclusive' | 'unavailable'
  reason?: string
  events: RuntimeErrorEvent[]
}

const PAGE_LIMIT = 100

/** Every event from `from` on, following the cursor to the head, which is the next read's start. */
export async function drainRuntimeErrors(read: RuntimeErrorRead, origin: string, from: RuntimeErrorQuery): Promise<Drained> {
  const events: RuntimeErrorEvent[] = []
  let cursor = from
  let expired = false
  for (;;) {
    const page = await read(origin, { ...cursor, limit: PAGE_LIMIT })
    if (page.status !== 'available') return { status: 'unavailable', reason: page.reason }
    expired ||= page.cursorExpired
    events.push(...page.events)
    cursor = { sessionId: page.nextCursor.sessionId, after: page.nextCursor.after }
    if (page.events.length < PAGE_LIMIT) return { status: 'available', sessionId: page.sessionId, head: cursor, dropped: page.dropped, expired, events }
  }
}

/** The window between a head read before some work and a drain from that head after it. */
export function judgeWindow(start: Drained, end: Drained): ErrorWindow {
  if (start.status !== 'available') return { status: 'unavailable', reason: start.reason, events: [] }
  if (end.status !== 'available') return { status: 'unavailable', reason: end.reason, events: [] }
  if (end.sessionId !== start.sessionId) return { status: 'inconclusive', reason: 'The app restarted, so errors from before the restart are gone.', events: end.events }
  if (end.expired) return { status: 'inconclusive', reason: 'Errors were evicted before they were read.', events: end.events }
  if (end.dropped > start.dropped) return { status: 'inconclusive', reason: `${end.dropped - start.dropped} error(s) were dropped.`, events: end.events }
  return { status: 'conclusive', events: end.events }
}
