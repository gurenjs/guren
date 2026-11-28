process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, test, expect } from 'bun:test'
import { z } from 'zod'
import { deriveAgentTools } from '../../src/agent/derive'
import { createAgentInvocationPipeline, type AgentInvocationPipeline } from '../../src/agent/pipeline'
import { createApp } from '../../src/http/Application'
import { Controller } from '../../src/mvc/Controller'
import type { Router } from '../../src/mvc/Router'

/**
 * Confirmation through a mounted router (RFC 0042 §2.2). The pipeline's own tests
 * stub the application; the promise here is the real seam's: the question is
 * asked only for a call the route would accept, and the action runs once, after
 * the answer.
 */
let archived: number[] = []

class PostController extends Controller {
  async archive() {
    const { id } = this.validateParams(z.object({ id: z.coerce.number() }))
    archived.push(id)
    return this.json({ archived: id })
  }
}

async function pipelineFor(register: (router: Router) => void): Promise<{ pipeline: AgentInvocationPipeline; tool: ReturnType<typeof deriveAgentTools>['tools'][number] }> {
  const app = createApp({ routes: register })
  await app.boot()
  const [tool] = deriveAgentTools(app.router.definitions()).tools
  const pipeline = createAgentInvocationPipeline({
    app,
    principal: { kind: 'user', id: 7 },
    abilities: ['tools:*'],
    surface: 'mcp',
  })
  return { pipeline, tool: tool! }
}

const register = (router: Router): void => {
  router
    .post('/posts/:id/archive', { body: z.object({ reason: z.string().min(3) }) }, [PostController, 'archive'])
    .name('posts.archive')
    .agent({ confirm: { message: 'This hides the post from readers.' } })
}

describe('agent confirmation through a mounted route', () => {
  test('should ask about a call the route accepts, without running the action', async () => {
    archived = []
    const { pipeline, tool } = await pipelineFor(register)

    const result = await pipeline.invoke({ tool, args: { id: 5, reason: 'outdated' } })

    expect(result.status).toBe('denied')
    if (result.status !== 'denied') return
    expect(result.denial.reason).toBe('confirmation')
    expect(result.denial.confirmation?.message).toBe('This hides the post from readers.')
    expect(archived).toEqual([])
  })

  test('should answer a call the route would refuse with its validation errors, and no question', async () => {
    archived = []
    const { pipeline, tool } = await pipelineFor(register)

    const result = await pipeline.invoke({ tool, args: { id: 5, reason: 'no' } })

    expect(result.status).toBe('executed')
    if (result.status !== 'executed') return
    expect(result.outcome.status).toBe(422)
    expect(result.outcome.isError).toBe(true)
    expect(archived).toEqual([])
  })

  test('should run the action once, for the arguments the caller agreed to', async () => {
    archived = []
    const { pipeline, tool } = await pipelineFor(register)
    const args = { id: 5, reason: 'outdated' }
    const asked = await pipeline.invoke({ tool, args })
    const fingerprint = asked.status === 'denied' ? asked.denial.confirmation?.fingerprint : undefined
    expect(fingerprint).toBeDefined()

    const other = await pipeline.invoke({ tool, args: { id: 6, reason: 'outdated' }, confirmed: fingerprint })
    expect(other.status).toBe('denied')
    expect(archived).toEqual([])

    const result = await pipeline.invoke({ tool, args, confirmed: fingerprint })

    expect(result.status).toBe('executed')
    expect(archived).toEqual([5])
  })
})
