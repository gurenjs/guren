import { z } from 'zod'

export const TicketIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const ListTicketsQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
})

export const CreateTicketSchema = z.object({
  title: z.string().min(1).max(200),
  /** ISO 8601. Present so the seed data can be backdated past `STALE_DAYS`. */
  createdAt: z.iso.datetime().optional(),
})

const TicketSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  status: z.enum(['open', 'closed']),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * The agent reads this schema out of the tool catalogue, so it is the contract
 * `Triager.sweep()` parses — not documentation.
 */
export const TicketListResponseSchema = z.object({
  tickets: z.array(TicketSchema),
})

export const TicketResponseSchema = z.object({
  ticket: TicketSchema,
})
