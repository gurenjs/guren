import { beforeAll, describe, expect, test } from 'bun:test'

import type { TestApp } from '@guren/testing'

import { TicketDigest } from '../app/Ai/Agents/TicketDigest'
import { operatorToken, testApp } from './support/app'

let http: TestApp
let bearer: string

beforeAll(async () => {
  http = await testApp()
  bearer = await operatorToken('digest-operator')
})

function asOperator(): TestApp {
  return http.withHeaders({ Authorization: `Bearer ${bearer}` })
}

describe('TicketDigest', () => {
  test('should read tickets through the real route and answer with the scripted digest', async () => {
    const created = await (
      await asOperator().post('/tickets', { title: 'Printer on fire' }).assertStatus(201)
    ).json<{ ticket: { id: number } }>()

    // Only the model is scripted: the tool call below dispatches into GET /tickets as the operator.
    using ai = http.fakeAi()
    ai.respond(TicketDigest, [
      {
        toolCalls: [{ name: 'tickets_index', input: { status: 'open' } }],
        then: { output: { summary: 'One printer fire.', staleTicketIds: [] } },
      },
    ])

    const body = await (
      await asOperator().post('/ops/agents/digest', {}).assertOk()
    ).json<{ digest: { summary: string } }>()

    expect(body.digest.summary).toBe('One printer fire.')
    ai.assertPrompted(TicketDigest, (input) => input.startsWith('Today is '))
    const [listed] = ai.calls(TicketDigest)[0]!.toolCalls
    expect(listed?.name).toBe('tickets_index')
    const { tickets } = listed!.output as { tickets: Array<{ id: number }> }
    expect(tickets.map((ticket) => ticket.id)).toContain(created.ticket.id)
  })

})
