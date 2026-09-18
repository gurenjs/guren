import { Controller } from '@guren/core'

import { TicketDigest } from '../../Ai/Agents/TicketDigest'
import { TRIAGER_UNAVAILABLE, triagerStub } from '../../Services/triager'

/**
 * The operator's half of the agent, as JSON. `/agents/*` is the SDK's reserved
 * router prefix in the generated worker and is deny-all, so these routes live
 * under `/ops/agents/` — a route registered under `/agents/` would be
 * unreachable, not merely refused.
 */
export default class AgentOpsController extends Controller {
  async show(): Promise<Response> {
    const stub = triagerStub()
    if (!stub) return this.unavailable()
    return this.json({ report: await stub.report() })
  }

  async sweep(): Promise<Response> {
    const stub = triagerStub()
    if (!stub) return this.unavailable()
    return this.json({ swept: await stub.sweep() })
  }

  /** Runs on Bun and on Workers alike: no Durable Object, just a model call in this request. */
  async digest(): Promise<Response> {
    const operator = await this.auth.userOrFail<{ id: number }>()
    const response = await this.make('ai')
      .agent(TicketDigest)
      .as(operator)
      .prompt(`Today is ${new Date().toISOString().slice(0, 10)}. Write the digest.`)
    return this.json({ digest: response.output })
  }

  private unavailable(): Response {
    return this.json({ error: TRIAGER_UNAVAILABLE }, { status: 503 })
  }
}
