import { Controller } from '@guren/core'

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

  private unavailable(): Response {
    return this.json({ error: TRIAGER_UNAVAILABLE }, { status: 503 })
  }
}
