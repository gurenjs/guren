/**
 * What one sweep should do, as arithmetic over durable state.
 *
 * Its own module because `Triager.ts` imports `@guren/plugin-agents/agent`,
 * whose graph statically imports `cloudflare:workers` — so nothing reaching it
 * can be exercised on Bun, and this is the part worth testing there.
 */

/** The shape `tickets.index` advertises, as its `output` schema states it. */
export interface TicketSummary {
  id: number
  title: string
  status: 'open' | 'closed'
  createdAt: string
}

/** How old an open ticket has to be before the triager asks to close it. */
export const STALE_DAYS = 7

/**
 * Fresh asks per sweep. D1 allows 50 queries per Worker invocation on the Free
 * plan and a sweep is one invocation: the index call is 1, and each new ask
 * costs `findMatch` + `create`, so 1 + 2 × 10 = 21.
 */
export const MAX_ASKS_PER_SWEEP = 10

const DAY_MS = 24 * 60 * 60 * 1000

/** Ticket id, as the JSON object key it becomes, to the request's ISO expiry. */
export type ParkedAsks = Record<string, string>

/** The parts of the agent's state a plan reads. */
export interface SweepInputs {
  declined: readonly number[]
  parked: ParkedAsks
}

export interface SweepPlan {
  /** Every open ticket past the cutoff, before anything is skipped. */
  stale: TicketSummary[]
  /** The ones to ask about now, capped at {@link MAX_ASKS_PER_SWEEP}. */
  ask: TicketSummary[]
  /** `parked` with the entries whose approval window has closed dropped. */
  parked: ParkedAsks
}

/**
 * A ticket already parked on a human is skipped rather than re-asked: the
 * approval gate deduplicates on identical arguments, so a second call returns
 * the same request — but it still costs a tool call and a `findMatch`, and with
 * a per-minute budget that is how pending tickets starve every later id.
 */
export function planSweep(
  open: readonly TicketSummary[],
  state: SweepInputs,
  now: Date,
): SweepPlan {
  const parked = livingAsks(state.parked, now)
  const cutoff = now.getTime() - STALE_DAYS * DAY_MS
  const stale = open.filter((ticket) => Date.parse(ticket.createdAt) < cutoff)
  const ask = stale
    .filter(
      (ticket) =>
        !state.declined.includes(ticket.id) && parked[String(ticket.id)] === undefined,
    )
    .slice(0, MAX_ASKS_PER_SWEEP)

  return { stale, ask, parked }
}

/**
 * The asks still inside their window. A request past its expiry can never be
 * approved, so holding on to the entry would park that ticket for good.
 */
function livingAsks(parked: ParkedAsks, now: Date): ParkedAsks {
  const living: ParkedAsks = {}
  for (const [id, expiresAt] of Object.entries(parked)) {
    const at = Date.parse(expiresAt)
    if (!Number.isNaN(at) && at > now.getTime()) living[id] = expiresAt
  }
  return living
}
