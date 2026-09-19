import { beforeAll, describe, expect, test } from 'bun:test'

import type { TestApp } from '@guren/testing'

import { operatorToken, testApp } from './support/app'

let http: TestApp
let bearer: string

beforeAll(async () => {
  http = await testApp()
  bearer = await operatorToken('triage-operator')
})

function asOperator(): TestApp {
  return http.withHeaders({ Authorization: `Bearer ${bearer}` })
}

interface TicketBody {
  ticket: { id: number; category: string | null; categoryProbability: number | null; triage: string }
}

async function createTicket(title: string): Promise<number> {
  const body = await (await asOperator().post('/tickets', { title }).assertStatus(201)).json<TicketBody>()
  return body.ticket.id
}

describe('POST /tickets/:id/triage', () => {
  test('should categorize the ticket itself when the model clears the threshold', async () => {
    const id = await createTicket('Charged twice this month, please refund one')

    using ai = http.fakeAi()
    ai.answer([{ category: { type: 'choice', choice: 'billing', probabilities: { billing: 0.97, bug: 0.02, account: 0.01 } } }])

    const { ticket } = await (await asOperator().post(`/tickets/${id}/triage`).assertOk()).json<TicketBody>()

    expect(ticket).toMatchObject({ category: 'billing', categoryProbability: 0.97, triage: 'auto' })
    ai.assertEvaluated((call) => JSON.stringify(call.state).includes('Charged twice'))
    expect(Object.keys(ai.evaluations()[0]!.questions)).toEqual(['category'])
  })

  test('should park the ticket for review, keeping the guess, when the model is not sure', async () => {
    const id = await createTicket('It says my card is on file but the export is empty')

    using ai = http.fakeAi()
    ai.answer([{ category: { type: 'choice', choice: 'bug', probabilities: { billing: 0.38, bug: 0.55, account: 0.07 } } }])

    const { ticket } = await (await asOperator().post(`/tickets/${id}/triage`).assertOk()).json<TicketBody>()

    expect(ticket).toMatchObject({ category: 'bug', categoryProbability: 0.55, triage: 'review' })
    const listed = await (await asOperator().get('/tickets?triage=review').assertOk()).json<{ tickets: Array<{ id: number }> }>()
    expect(listed.tickets.map((row) => row.id)).toContain(id)
  })

  test('should expand a shorthand answer into a choice at probability 1', async () => {
    const id = await createTicket('Cannot sign in since the password reset')

    using ai = http.fakeAi()
    ai.answer([{ category: 'account' }])

    const { ticket } = await (await asOperator().post(`/tickets/${id}/triage`).assertOk()).json<TicketBody>()

    expect(ticket).toMatchObject({ category: 'account', categoryProbability: 1, triage: 'auto' })
  })

  test('should refuse a scripted choice outside the enum, so the fake cannot answer what the model cannot', async () => {
    const id = await createTicket('Where is my invoice?')

    const ai = http.fakeAi()
    ai.answer([{ category: 'refund' }])

    await asOperator().post(`/tickets/${id}/triage`).assertStatus(500)
    expect(String(ai.evaluations()[0]!.error)).toContain('not one of its options: billing, bug, account')
    expect(() => ai[Symbol.dispose]()).toThrow('not one of its options')
  })

  test('should fail when nothing is scripted, naming the fix', async () => {
    const id = await createTicket('Renewal charged the old price')

    const ai = http.fakeAi()

    await asOperator().post(`/tickets/${id}/triage`).assertStatus(500)
    expect(() => ai[Symbol.dispose]()).toThrow('Script it with ai.answer([{ ... }])')
  })
})

describe('POST /tickets/:id/category', () => {
  test('should let an operator confirm a category and clear the probability', async () => {
    const id = await createTicket('Please delete my account and its data')

    const { ticket } = await (
      await asOperator().post(`/tickets/${id}/category`, { category: 'account' }).assertOk()
    ).json<TicketBody>()

    expect(ticket).toMatchObject({ category: 'account', categoryProbability: null, triage: 'confirmed' })
  })

  test('should reject a category the enum does not hold', async () => {
    const id = await createTicket('Anything')

    await asOperator().post(`/tickets/${id}/category`, { category: 'refund' }).assertStatus(422)
  })
})
