// Worker entry for audit-emitter.workerd.test.ts — bundled with Bun.build at
// test time and executed inside workerd, where a promise the request context
// does not know about is abandoned when that context closes.
import type { ExecutionContext } from 'hono'

import { createAuditEmitter } from '../../src/agent/audit-emitter'
import { AgentToolInvoked } from '../../src/agent/events'

interface Env {
  DB: { prepare: (sql: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown> } } }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const params = new URL(request.url).searchParams
    const tool = params.get('tool') ?? 'unknown'
    const defer = params.get('defer') === '1'

    const emit = createAuditEmitter(
      async (record) => {
        // A sink that has not finished by the time the response is produced —
        // any D1 write is this, the round trip being the delay.
        await new Promise((done) => setTimeout(done, 50))
        await env.DB.prepare('INSERT INTO audit (tool) VALUES (?)').bind(record.tool).run()
      },
      undefined,
      undefined,
      defer ? { defer: ctx.waitUntil.bind(ctx) } : {},
    )

    emit(new AgentToolInvoked({ kind: 'user', id: 1 }, tool, {}, 200, 1, 'mcp'))
    return new Response('ok')
  },
}
