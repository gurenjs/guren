import { describe, test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'

/**
 * The dispatcher's identity mark across the **built** entries: `./agent` builds
 * the request, the root's force-https reads the mark, two rolldown entries.
 * A copy of `internal/dispatched-request.ts` per entry would be two `WeakSet`s,
 * and tool calls would meet the redirect with the source suite green.
 * Skipped when `dist/` is absent.
 */
const distDir = fileURLToPath(new URL('../../dist', import.meta.url))
const built = existsSync(`${distDir}/index.js`) && existsSync(`${distDir}/agent/public.js`)

describe.if(built)('the dispatched-request mark (built entries)', () => {
  test('should let a request built by the agent entry through the root entry\'s force-https', async () => {
    // By file path: in this repo the package name resolves to `src/` through the
    // root tsconfig `paths`, where one module holds the set whatever rolldown emits.
    const { buildToolRequest } = (await import(`${distDir}/agent/public.js`)) as typeof import('../../src/agent/public')
    const { Router, createForceHttpsMiddleware, deriveAgentTools } = (await import(
      `${distDir}/index.js`
    )) as typeof import('../../src/index')

    const router = new Router()
    router.get('/posts', () => new Response('ok')).name('posts.index').agent({})
    const tool = deriveAgentTools(router.definitions()).tools[0]!
    const request = buildToolRequest(tool, {}, { origin: 'http://app.example' })
    if (!('request' in request)) throw new Error('the tool request did not build')

    const app = new Hono()
    app.use('*', createForceHttpsMiddleware())
    app.get('/posts', (c) => c.text('ok'))

    expect((await app.fetch(request.request)).status).toBe(200)
  })
})
