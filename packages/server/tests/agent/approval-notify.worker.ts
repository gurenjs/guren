// Worker entry for approval-notify.workerd.test.ts — bundled with Bun.build at
// test time and executed inside workerd, where a promise the request context
// does not know about is abandoned when that context closes.
import type { ExecutionContext } from 'hono'

import { buildAgentApprovalRequest } from '../../src/agent/approval'
import { notifyApprovers } from '../../src/agent/gate'

interface Env {
  DB: { prepare: (sql: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown> } } }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const params = new URL(request.url).searchParams
    const tool = params.get('tool') ?? 'unknown'
    const defer = params.get('defer') === '1'

    const notify = notifyApprovers(
      async (filed) => {
        // A channel that has not answered by the time the response is produced
        // — a Slack webhook or an SMTP handshake is this, the round trip being
        // the delay.
        await new Promise((done) => setTimeout(done, 50))
        await env.DB.prepare('INSERT INTO notified (tool) VALUES (?)').bind(filed.tool).run()
      },
      defer ? ctx.waitUntil.bind(ctx) : undefined,
    )

    notify(
      buildAgentApprovalRequest(
        { tool, input: {}, fingerprint: 'fp', principal: { kind: 'user', id: 1 } },
        new Date(),
      ),
    )
    return new Response('ok')
  },
}
