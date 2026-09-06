import { Controller } from '@guren/core'
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'

import type { Env, TriagerStub } from '../../../config/env'

/**
 * One triager for the whole application, addressed by name. A per-tenant demo
 * would derive the instance from the request instead.
 */
const INSTANCE = 'main'

/**
 * The operator's half of the agent: the app talks to its own agent through the
 * Durable Object binding, never over HTTP. `/agents/*` is the SDK's reserved
 * router prefix in the generated worker and is deny-all, so these routes live
 * under `/ops/agents/` — a route registered under `/agents/` would be
 * unreachable, not merely refused.
 */
export default class AgentOpsController extends Controller {
  async show(): Promise<Response> {
    const stub = this.triager()
    if (!stub) return this.unavailable()
    return this.json({ report: await stub.report() })
  }

  async sweep(): Promise<Response> {
    const stub = this.triager()
    if (!stub) return this.unavailable()
    return this.json({ swept: await stub.sweep() })
  }

  private triager(): TriagerStub | null {
    if (!isWorkersRuntime()) return null
    const namespace = getWorkersEnv<Env>().TRIAGER
    if (!namespace) return null
    return namespace.get(namespace.idFromName(INSTANCE))
  }

  private unavailable(): Response {
    return this.json(
      {
        error: 'Agents run on Workers. Start this app with `wrangler dev --local`; '
          + 'under `bun run dev` there is no Durable Object namespace to address.',
      },
      { status: 503 },
    )
  }
}
