// Worker entry for logger.workerd.test.ts — bundled with Bun.build at test time
// and executed inside workerd, where a promise the request context does not
// know about is abandoned when that context closes.
import { Hono, type ExecutionContext } from 'hono'

import { LogManager } from '../../src/logging'
import { runInRequestScope } from '../../src/support/request-deferrer'

interface Env {
  DB: { prepare: (sql: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown> } } }
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

let app: Hono | undefined

// Built once per isolate, the way the container builds its `log` singleton: a
// logger that outlives every request and was handed none of them.
function boot(env: Env): Hono {
  const log = new LogManager({ default: 'd1', channels: { d1: { driver: 'd1' } } })
  log.registerDriver('d1', () => ({
    log: async (entry) => {
      // A channel that has not answered by the time the response is produced;
      // a log service's HTTP round trip is this.
      await delay(50)
      await env.DB.prepare('INSERT INTO logged (tool) VALUES (?)').bind(entry.message).run()
    },
  }))

  const hono = new Hono()
  hono.get('/', async (c) => {
    const tool = c.req.query('tool') ?? 'unknown'
    // Past a timer first, so the scope has to survive continuations and not
    // only the synchronous call that entered it.
    await delay(1)
    log.info(tool)
    if (tool === 'held') await delay(200)
    return c.text('ok')
  })
  return hono
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const hono = (app ??= boot(env))
    const defer = new URL(request.url).searchParams.get('defer') === '1'
    // What `Application.fetch` does, with the context withheld for `defer=0`.
    return runInRequestScope(defer ? ctx : undefined, async () => hono.fetch(request, env, ctx))
  },
}
