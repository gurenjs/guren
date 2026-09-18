import { Agent, Output } from '@guren/plugin-ai'
import { z } from 'zod'

const Digest = z.object({
  summary: z.string(),
  staleTicketIds: z.array(z.number().int()),
})

/**
 * The in-process counterpart of `app/Agents/Triager.ts`: a model call made inside
 * the operator's request, acting as that operator. It reads tickets through the
 * same `tickets_index` route the triager calls, and it can do nothing else.
 */
export class TicketDigest extends Agent<typeof TicketDigest.scopes> {
  static override agentName = 'ticket-digest'
  static override scopes = ['tool:tickets_index'] as const

  instructions = [
    'You write a short digest of the open support tickets for an operator.',
    'List them with the tickets_index tool (status "open"), then summarize what they are about in two sentences.',
    'A ticket is stale when it was created more than seven days before the date the operator gives you.',
  ].join(' ')

  output = Output.object({ schema: Digest })

  override tools() {
    return this.appTools(['tickets_index'])
  }
}
