import { evaluate, type AiManager } from '@guren/plugin-ai'

import { tickets } from '../../db/schema'
import type { TicketCategory, TicketTriage } from '../Services/tickets'
import { choiceFrom } from './questions'

/**
 * Below this, the model's answer is a suggestion an operator confirms. Not a
 * number the model documents: pick it from the precision a labelled sample of
 * your own tickets gives at each cutoff (the README shows the measurement).
 */
export const AUTO_CATEGORY_THRESHOLD = 0.9

export interface TriageDecision {
  category: TicketCategory
  categoryProbability: number
  triage: Extract<TicketTriage, 'auto' | 'review'>
}

/** One evaluation of a ticket: which team owns it, and whether the model is sure enough to say so alone. */
export async function triageTicket(manager: AiManager, ticket: { title: string }): Promise<TriageDecision> {
  const { answers } = await evaluate({
    manager,
    state: { title: ticket.title },
    questions: {
      category: choiceFrom(tickets.category, 'Which team owns this support ticket?', {
        billing: 'Charges, invoices, refunds and plans',
        bug: 'Something in the product is broken or wrong',
        account: 'Sign-in, access, profile and data requests',
      }),
    },
  })
  const { choice, probabilities } = answers.category
  // The SDK's LLM adapters answer a choice with no distribution; treating that as 0 would
  // park every ticket for review without saying why. The threshold needs a native one.
  if (!probabilities) throw new Error('The evaluation provider returned no probability distribution for `category`; triage needs an evaluation model that does (Jev).')
  const categoryProbability = probabilities[choice] ?? 0

  return {
    category: choice,
    categoryProbability,
    triage: categoryProbability >= AUTO_CATEGORY_THRESHOLD ? 'auto' : 'review',
  }
}
