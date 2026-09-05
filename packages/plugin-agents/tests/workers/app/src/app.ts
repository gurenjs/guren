/**
 * The fixture application `guren cloudflare:build` assembles the workerd
 * suite's worker from.
 *
 * A real Guren app: two agent tools and a probe surface the tests drive over
 * HTTP rather than by importing this module, so no assertion depends on the
 * test and the worker sharing a module instance.
 */
import {
  AgentToolInvoked,
  EventServiceProvider,
  createApp,
  type EventManager,
  type Router,
} from '@guren/core'
import { z } from 'zod'

import { agentsPlugin } from '../../../../src/plugin'
import agents from '../config/agents'
import { lastRoutedTarget, setRoutingMode, type RoutingMode } from '../config/routing-switch'

/** Principal ids the audit trail recorded, reported by `GET /__probe`. */
const auditedPrincipals: string[] = []

/**
 * How many times the Workers boot latch let a boot through.
 *
 * `Application.boot()` is idempotent on its own, so counting providers would
 * always answer 1 — this counts what `bootWorkersApp`'s per-app latch is
 * supposed to hold at one however many entrypoints wake the isolate.
 */
let boots = 0

const RoutingQuery = z.object({ mode: z.enum(['absent', 'allow', 'deny', 'response', 'throw']) })

function registerRoutes(router: Router): void {
  router
    .get('/posts', () => Response.json({ posts: [{ id: 1, title: 'Hello' }] }))
    .name('posts.index')
    .agent({ description: 'List posts' })

  router
    .post('/posts', { body: z.object({ title: z.string() }) }, ({ body }) =>
      Response.json({ created: body.title }))
    .name('posts.store')
    .agent({ description: 'Create a post' })

  router.get('/__probe', () =>
    Response.json({ boots, principals: auditedPrincipals, target: lastRoutedTarget() ?? null }))

  // GET rather than POST: a direct request from the suite carries no session
  // and no XSRF token, and this switch is fixture plumbing, not a tool.
  router.get('/__probe/routing', { query: RoutingQuery }, ({ query }) => {
    setRoutingMode(query.mode as RoutingMode)
    auditedPrincipals.length = 0
    return Response.json({ mode: query.mode })
  })
}

const application = createApp({
  routes: registerRoutes,
  providers: [EventServiceProvider, agentsPlugin(agents)],
})

// A counting wrapper rather than the Application itself: `bootWorkersApp`
// latches on this object, so `boots` is exactly the number of boots that
// reached the application.
export default {
  async boot(): Promise<void> {
    boots += 1
    await application.boot()
    application.container
      .make<EventManager>('events')
      .on(AgentToolInvoked, (event) => {
        auditedPrincipals.push(String(event.principal?.id))
      })
  },
  fetch: (
    request: Request,
    env?: unknown,
    executionCtx?: Parameters<typeof application.fetch>[2],
  ): Promise<Response> => application.fetch(request, env, executionCtx),
}
