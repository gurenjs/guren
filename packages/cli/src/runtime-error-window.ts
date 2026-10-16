/**
 * A window of the runtime-error feed (RFC 0032 §4) around work this process does: the head
 * read before it, everything after it drained, and whether that is all there was. Shared by
 * `browser:doctor` and `browser:record` (RFC 0033 §4, §7), so a restart, an expired cursor or
 * dropped events read as not conclusive in both, never as zero errors.
 */

import type { RuntimeErrorQuery, RuntimeErrorResult } from './runtime-errors'

export type RuntimeErrorEvent = Extract<RuntimeErrorResult, { status: 'available' }>['events'][number]
export type RuntimeErrorRead = (origin: string, query: RuntimeErrorQuery) => Promise<RuntimeErrorResult>

/** Where the feed stood before the work: what a window is judged from, and what a step stores. */
export type WindowStart =
  | { status: 'available'; head: { sessionId: string; after: number }; dropped: number }
  | { status: 'unavailable'; reason: string }

export interface ErrorWindow {
  status: 'conclusive' | 'inconclusive' | 'unavailable'
  reason?: string
  events: RuntimeErrorEvent[]
}

type Drained =
  | { status: 'unavailable'; reason: string }
  | { status: 'available'; head: { sessionId: string; after: number }; dropped: number; expired: boolean; events: RuntimeErrorEvent[] }

const PAGE_LIMIT = 100

/** Every event from `from` on, following the cursor to the head, which is the next read's start. */
async function drain(read: RuntimeErrorRead, origin: string, from: RuntimeErrorQuery): Promise<Drained> {
  const events: RuntimeErrorEvent[] = []
  let cursor = from
  let expired = false
  for (;;) {
    const page = await read(origin, { ...cursor, limit: PAGE_LIMIT })
    if (page.status !== 'available') return { status: 'unavailable', reason: page.reason }
    expired ||= page.cursorExpired
    events.push(...page.events)
    const head = { sessionId: page.nextCursor.sessionId, after: page.nextCursor.after }
    if (page.events.length < PAGE_LIMIT) return { status: 'available', head, dropped: page.dropped, expired, events }
    cursor = head
  }
}

/** The feed's head before some work; nothing before it is ever judged. */
export async function readWindowStart(read: RuntimeErrorRead, origin: string): Promise<WindowStart> {
  const start = await drain(read, origin, {})
  return start.status === 'available' ? { status: 'available', head: start.head, dropped: start.dropped } : start
}

/** Everything since `start`, and whether that is all there was. */
export async function windowSince(read: RuntimeErrorRead, origin: string, start: WindowStart): Promise<ErrorWindow> {
  if (start.status !== 'available') return { status: 'unavailable', reason: start.reason, events: [] }
  const end = await drain(read, origin, start.head)
  if (end.status !== 'available') return { status: 'unavailable', reason: end.reason, events: [] }
  if (end.head.sessionId !== start.head.sessionId) return { status: 'inconclusive', reason: 'The app restarted, so errors from before the restart are gone.', events: end.events }
  if (end.expired) return { status: 'inconclusive', reason: 'Errors were evicted before they were read.', events: end.events }
  if (end.dropped > start.dropped) return { status: 'inconclusive', reason: `${end.dropped - start.dropped} error(s) were dropped.`, events: end.events }
  return { status: 'conclusive', events: end.events }
}
