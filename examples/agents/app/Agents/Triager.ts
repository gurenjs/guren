import { GurenAgent } from '@guren/plugin-agents/agent'
import type { AgentToolApprovalSettled, AgentToolCallResult } from '@guren/plugin-agents'

import type { Env } from '../../config/env'
import { planSweep, type ParkedAsks, type TicketSummary } from './sweep-plan'

/** Settled approvals kept for `report()`. State is a durable value, not a log. */
const SETTLED_LIMIT = 20

/** Ticket ids a human refused. Bounded, so a long-lived instance stays small. */
const DECLINED_LIMIT = 200

interface SettledRecord {
  requestId: string
  tool: string
  status: AgentToolApprovalSettled['status']
  /**
   * The retry itself: `ok` ran, `null` means nothing was called. `failed`
   * folds three answers this report does not separate — refused, errored, and
   * re-parked under a fresh request, which the ledger goes on retrying.
   */
  retried: 'ok' | 'failed' | null
  at: string
}

interface SweepSummary {
  at: string
  open: number
  /** Open tickets past the cutoff: `stale = asked + closed + refused + deferred`. */
  stale: number
  /** Calls parked on a human. The ledger retries each one once it settles. */
  asked: number
  /** Tickets already carrying an approval, closed on this sweep. */
  closed: number
  /** Calls the pipeline refused, or that the application answered with an error. */
  refused: number
  /** Stale tickets left for later: declined, already parked, or over the ask cap. */
  deferred: number
  /** Why `tickets.index` answered nothing, when it did: a blind sweep is not an empty one. */
  error?: string
}

export interface TriagerState {
  lastRunAt: string | null
  lastSweep: SweepSummary | null
  declined: number[]
  parked: ParkedAsks
  settled: SettledRecord[]
}

/**
 * An agent is durable identity and durable state — not a durable JavaScript
 * stack. An instance is evicted after inactivity, so anything that must survive
 * is checkpointed into `this.setState` and resumed by a schedule.
 */
export class Triager extends GurenAgent<Env, TriagerState> {
  initialState: TriagerState = {
    lastRunAt: null,
    lastSweep: null,
    declined: [],
    parked: {},
    settled: [],
  }

  async onStart(): Promise<void> {
    // A recurring schedule is idempotent in the SDK (it matches on timing,
    // callback and payload), so re-registering on every wake creates one row.
    await this.schedule('0 * * * *', 'sweep')
  }

  /** The public RPC behind `GET /ops/agents/triager`. */
  async report(): Promise<TriagerState> {
    return this.#current()
  }

  /**
   * `initialState` seeds only a *new* instance. One that ran an earlier deploy
   * carries the state shape it was written with, so a field added later reads
   * `undefined` there — measured: `Object.entries(state.parked)` threw on the
   * production instance the first sweep after `parked` shipped.
   */
  #current(): TriagerState {
    return { ...this.initialState, ...this.state }
  }

  /** The schedule's callback, and the RPC `POST /ops/agents/triager/sweep` calls. */
  async sweep(): Promise<SweepSummary> {
    const now = new Date()
    const state = this.#current()
    const listed = await this.tools.call('tickets.index', { status: 'open' })
    const blind = failureOf(listed)
    const open = listed.ok && !listed.outcome.isError ? readTickets(listed) : []
    const plan = planSweep(open, state, now)

    const parked = { ...plan.parked }
    let asked = 0
    let closed = 0
    let refused = 0
    for (const ticket of plan.ask) {
      const result = await this.tools.call('tickets.close', { id: ticket.id })
      if (result.pending) {
        asked += 1
        // Only with an expiry: without one nothing would age the entry out,
        // and the ledger declines to checkpoint such a call for that reason.
        if (result.expiresAt) parked[String(ticket.id)] = result.expiresAt
        continue
      }

      const why = failureOf(result)
      if (!why) {
        closed += 1
        continue
      }
      // A gate refusal, a dispatch failure, or a call the application itself
      // answered with an error: not a human's answer, so not `declined`.
      refused += 1
      console.warn(`[triager] tickets.close ${ticket.id} was not run: ${why}`)
    }

    const summary: SweepSummary = {
      ...(blind ? { error: blind } : {}),
      at: now.toISOString(),
      open: open.length,
      stale: plan.stale.length,
      asked,
      closed,
      refused,
      deferred: plan.stale.length - plan.ask.length,
    }
    this.setState({ ...state, lastRunAt: summary.at, lastSweep: summary, parked })
    return summary
  }

  /**
   * `status` is the queue's verdict; `result` is what the repeated call
   * answered, and it can itself be a refusal. `approved` with no `result` means
   * an earlier wake already ran the retry — see RFC 0017 §5.
   */
  onToolApprovalSettled(event: AgentToolApprovalSettled): void {
    const state = this.#current()
    const ticketId = typeof event.args?.id === 'number' ? event.args.id : undefined
    // Only a human's "no" is remembered. An expired request was never answered,
    // so the next sweep may ask again.
    const declined =
      event.status === 'rejected' && ticketId !== undefined
        ? [...state.declined, ticketId].slice(-DECLINED_LIMIT)
        : state.declined

    // Settled, so the ticket is askable again. An `'unreadable'` row carries no
    // `args`; its entry ages out at the expiry it was parked with instead.
    const parked = { ...state.parked }
    if (ticketId !== undefined) delete parked[String(ticketId)]

    this.setState({
      ...state,
      declined,
      parked,
      settled: [
        ...state.settled,
        {
          requestId: event.requestId,
          tool: event.tool,
          status: event.status,
          retried: retriedOf(event.result),
          at: new Date().toISOString(),
        },
      ].slice(-SETTLED_LIMIT),
    })
  }
}

/**
 * Why a call answered nothing, or `undefined` when it ran.
 *
 * `ok` says the route dispatched; `outcome.isError` is the application's own
 * verdict. Reading the first as the second turns a 500 into an empty list.
 */
function failureOf(result: AgentToolCallResult): string | undefined {
  if (!result.ok) return result.message
  if (result.outcome.isError) return `the tool answered HTTP ${result.outcome.status}`
  return undefined
}

function retriedOf(result: AgentToolCallResult | undefined): 'ok' | 'failed' | null {
  if (!result) return null
  return failureOf(result) ? 'failed' : 'ok'
}

/**
 * The tool declares an object `output` schema, so the dispatch carries the
 * parsed body as `structuredContent` and nothing here re-parses text.
 */
function readTickets(result: AgentToolCallResult & { ok: true }): TicketSummary[] {
  const structured = result.outcome.structuredContent as { tickets?: TicketSummary[] } | undefined
  return structured?.tickets ?? []
}
