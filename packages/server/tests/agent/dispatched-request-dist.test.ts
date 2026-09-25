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
    // Self-referencing imports, so the package's own `exports` map decides
    // which files these are, the same resolution a consuming app performs.
    const { buildToolRequest } = await import('@guren/server/agent')
    const { Router, createForceHttpsMiddleware, deriveAgentTools } = await import('@guren/server')

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
