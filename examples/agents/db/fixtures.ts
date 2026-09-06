/**
 * The demo's fixture rows, shared by the seeder (`bun run db:seed`, bun:sqlite)
 * and `db/seed-d1.ts` (which renders them as SQL for `wrangler d1 execute`).
 * One definition, because the two paths have to agree on what "stale" means.
 */

/** Older than `STALE_DAYS` in `app/Agents/Triager.ts`, so the sweep asks about them. */
const STALE_AGE_DAYS = 12

const DAY_MS = 24 * 60 * 60 * 1000

export const OPERATOR = { name: 'Ops On-Call', email: 'ops@example.test' }

export interface TicketFixture {
  title: string
  status: 'open' | 'closed'
  createdAt: Date
  updatedAt: Date
}

export function demoTickets(now = new Date()): TicketFixture[] {
  const stale = new Date(now.getTime() - STALE_AGE_DAYS * DAY_MS)
  const fresh = new Date(now.getTime() - DAY_MS)

  return [
    { title: 'Login page 500s on Safari', status: 'open', createdAt: stale, updatedAt: stale },
    { title: 'Stale: invoice export truncates', status: 'open', createdAt: stale, updatedAt: stale },
    { title: 'Docs typo in the quickstart', status: 'open', createdAt: fresh, updatedAt: fresh },
    { title: 'Billing webhook retry storm', status: 'closed', createdAt: stale, updatedAt: fresh },
  ]
}
