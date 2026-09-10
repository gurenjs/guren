// Worker entry for audit-emitter.workerd.test.ts — bundled with Bun.build at
// test time and executed inside workerd, where a promise the request context
// does not know about is abandoned when that context closes.
import type { ExecutionContext } from 'hono'

import { createAuditEmitter } from './audit-emitter'
import { AgentToolInvoked } from './events'

/** workerd's own timer; `setTimeout` would do, but this is the platform API. */
declare const scheduler: { wait: (ms: number) => Promise<void> }

interface Env {
  DB: { prepare: (sql: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown> } } }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const tool = new URL(request.url).searchParams.get('tool') ?? 'unknown'
    const defer = new URL(request.url).searchParams.get('defer') === '1'

    const emit = createAuditEmitter(
      async (record) => {
        // A sink that has not finished by the time the response is produced —
        // any D1 write is this, the round trip being the delay.
        await scheduler.wait(50)
        await env.DB.prepare('INSERT INTO audit (tool) VALUES (?)').bind(record.tool).run()
      },
      undefined,
      () => new Date(),
      defer ? { defer: ctx.waitUntil.bind(ctx) } : {},
    )

    emit(new AgentToolInvoked({ kind: 'user', id: 1 }, tool, {}, 200, 1, 'mcp'))
    return new Response('ok')
  },
}
