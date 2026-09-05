/**
 * The fixture worker the workerd suite runs against.
 *
 * A real Guren application plus the two `GurenAgent` subclasses the tests
 * drive, shaped the way Part 2b's generated worker will be: the runtime is
 * published by a resolver registered at module scope. Every `cloudflare:test`
 * helper needs the class exported from `main`, so this file is both halves.
 */
import { AgentToolInvoked, EventServiceProvider, createApp, type EventManager, type Router } from '@guren/core'
import { z } from 'zod'

import { GurenAgent } from '../../src/agent'
import { agentsPlugin } from '../../src/plugin'
import { configureAgentRuntime } from '../../src/runtime'

interface Env extends Cloudflare.Env {
  TEST_AGENT: DurableObjectNamespace<TestAgent>
  STRAY_AGENT: DurableObjectNamespace<StrayAgent>
}

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
}

/**
 * Promise-latched, first caller wins — the invariant Part 2b's `bootAndFetch`
 * has to carry. Two agents woken in one isolate must not boot two apps.
 */
/** Principal ids the audit trail recorded, for the identity assertions. */
export const auditedPrincipals: string[] = []

let booting: Promise<void> | undefined

configureAgentRuntime(() => {
  booting ??= (async () => {
    const app = createApp({
      routes: registerRoutes,
      providers: [
        EventServiceProvider,
        agentsPlugin({
          agents: {
            triager: {
              module: 'tests/workers/worker.ts',
              export: 'TestAgent',
              // Read only, so the write tool below is a scope denial rather
              // than a missing route.
              scopes: ['tool:posts.index'],
            },
          },
        }),
      ],
    })
    // `agentsPlugin`'s own boot is what publishes the runtime.
    await app.boot()
    app.container
      .make<EventManager>('events')
      .on(AgentToolInvoked, (event) => {
        auditedPrincipals.push(String(event.principal?.id))
      })
  })()
  return booting
})

interface TestAgentState {
  lastTitle: string | null
  sweeps: number
}

export class TestAgent extends GurenAgent<Env, TestAgentState> {
  initialState: TestAgentState = { lastTitle: null, sweeps: 0 }

  /** Driven by `this.schedule(...)` + `runDurableObjectAlarm` in the suite. */
  async sweep(): Promise<void> {
    const result = await this.tools.call('posts.index', {})
    const title = result.ok
      ? (JSON.parse(textOf(result.outcome)) as { posts: Array<{ title: string }> }).posts[0]!.title
      : null
    this.setState({ lastTitle: title, sweeps: this.state.sweeps + 1 })
  }
}

/** Registered nowhere, on purpose. */
export class StrayAgent extends GurenAgent<Env, unknown> {}

export default {
  async fetch(): Promise<Response> {
    return new Response('fixture worker', { status: 200 })
  },
}

function textOf(outcome: { content: Array<{ type: string; text?: string }> }): string {
  return outcome.content.map((part) => part.text ?? '').join('')
}
