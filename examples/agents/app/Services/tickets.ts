/**
 * How a ticket row reaches an operator, on either surface. ISO 8601 strings,
 * because the agent reads the same shape out of `tickets.index`'s output
 * schema — a console rendering a different one would be describing a different
 * ticket than the one the agent asked to close.
 */
import { Ticket } from '../Models/Ticket'

export interface TicketRow {
  id: number
  title: string
  status: 'open' | 'closed'
  createdAt: Date
  updatedAt: Date
}

export interface TicketView {
  id: number
  title: string
  status: 'open' | 'closed'
  createdAt: string
  updatedAt: string
}

export function presentTicket(row: TicketRow): TicketView {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Newest first and bounded, unlike the `tickets.index` tool: this one renders a
 * page, and Cloudflare's Free plan allows 50 D1 queries per Worker invocation.
 */
export async function listTickets(limit: number): Promise<TicketView[]> {
  const rows = (await Ticket.newQuery().orderBy('id', 'desc').limit(limit).get()) as TicketRow[]
  return rows.map(presentTicket)
}
