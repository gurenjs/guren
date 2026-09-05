/**
 * The fixture application `guren cloudflare:build` assembles the workerd
 * suite's worker from.
 *
 * A real Guren app: three agent tools — one behind the approval queue — and a
 * probe surface the tests drive over HTTP rather than by importing this module,
 * so no assertion depends on the test and the worker sharing a module instance.
 */
// Assigned before `createApp` runs: `EncryptionServiceProvider.register()` reads
// `process.env.APP_KEY` at registration, and this module registers at evaluation.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import {
  AgentToolInvoked,
  EncryptionServiceProvider,
  EventServiceProvider,
  createApp,
  type EventManager,
  type Router,
} from '@guren/core'
import { z } from 'zod'

import { agentsPlugin } from '../../../../src/plugin'
import agents from '../config/agents'
import { approvalQueue } from '../config/approval-queue'
import { setHookThrows } from '../config/hook-switch'
import { lastRoutedTarget, setRoutingMode, type RoutingMode } from '../config/routing-switch'

/** Post ids the gated tool actually deleted, so a retry cannot run twice unseen. */
const destroyed: number[] = []

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

const HookQuery = z.object({ throws: z.enum(['yes', 'no']) })

const BreakQuery = z.object({ times: z.coerce.number().int().nonnegative() })

const ResolveQuery = z.object({
  id: z.string(),
  verdict: z.enum(['approved', 'rejected', 'expire']),
})

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

  router
    .delete('/posts/:id', { params: z.object({ id: z.coerce.number() }) }, ({ params }) => {
      destroyed.push(params.id)
      return Response.json({ destroyed: params.id })
    })
    .name('posts.destroy')
    .agent({ description: 'Delete a post', approval: 'required' })

  router.get('/__probe', () =>
    Response.json({
      boots,
      principals: auditedPrincipals,
      target: lastRoutedTarget() ?? null,
      destroyed,
      approvals: approvalQueue.records.map((record) => ({
        id: record.id,
        tool: record.tool,
        status: record.status,
        expiresAt: record.expiresAt,
        consumed: record.consumedAt !== undefined,
      })),
    }))

  // The human's half of the loop, as the suite plays it. `expire` rewrites the
  // record's own expiry rather than a clock: `agentApprovalStatusAt` derives
  // expiry from that field, so this is the one thing a test can move.
  router.get('/__probe/approvals', { query: ResolveQuery }, ({ query }) => {
    const record = approvalQueue.records.find((candidate) => candidate.id === query.id)
    if (!record) return Response.json({ error: 'no such request' }, { status: 404 })

    if (query.verdict === 'expire') {
      record.expiresAt = new Date(Date.now() - 1000).toISOString()
    } else {
      record.status = query.verdict
      record.resolvedAt = new Date().toISOString()
      record.resolvedBy = 'the-suite'
    }
    return Response.json({ id: record.id, status: record.status })
  })

  router.get('/__probe/break', { query: BreakQuery }, ({ query }) => {
    approvalQueue.failLookups = query.times
    return Response.json({ failLookups: query.times })
  })

  router.get('/__probe/hook', { query: HookQuery }, ({ query }) => {
    setHookThrows(query.throws === 'yes')
    return Response.json({ throws: query.throws })
  })

  router.get('/__probe/reset', () => {
    setHookThrows(false)
    approvalQueue.failLookups = 0
    approvalQueue.records.length = 0
    destroyed.length = 0
    auditedPrincipals.length = 0
    return Response.json({ reset: true })
  })

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
  providers: [EventServiceProvider, EncryptionServiceProvider, agentsPlugin(agents)],
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
