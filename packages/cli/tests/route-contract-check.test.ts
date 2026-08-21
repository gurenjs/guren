import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { Router, type RouteDefinition } from '@guren/core'
import { checkRouteContracts } from '../src/route-contract-check'
import { writeWorkspaceFiles } from './helpers'

const controller = () => new Response('ok')

function route(overrides: Partial<RouteDefinition> & Pick<RouteDefinition, 'path'>): RouteDefinition {
  return { method: 'GET', ...overrides }
}

async function run(definitions: RouteDefinition[]) {
  return checkRouteContracts({ cwd: '/nonexistent', definitions })
}

describe('checkRouteContracts', () => {
  describe('params schema keys', () => {
    it('reports a single pass when every key names a path parameter', async () => {
      const results = await run([
        route({ path: '/posts/:id', schemas: { params: z.object({ id: z.coerce.number() }) } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('pass')
      expect(results[0]?.message).toContain('1 route checked')
    })

    it('fails when a required key names a parameter the path does not declare', async () => {
      const results = await run([
        route({ path: '/posts/:id', schemas: { params: z.object({ postId: z.coerce.number() }) } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain("'postId'")
      expect(results[0]?.message).toContain('400')
      expect(results[0]?.suggestion).toContain("'id'")
    })

    // The two halves are split because their consequences differ: a required
    // key is a guaranteed 400, an omissible one never fails at all.
    it('warns rather than fails for an optional stray key', async () => {
      const results = await run([
        route({ path: '/posts/:id', schemas: { params: z.object({ postId: z.string().optional() }) } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.message).toContain("'postId'")
    })

    it('warns for a defaulted stray key, which silently substitutes for the URL', async () => {
      const results = await run([
        route({ path: '/posts/:id', schemas: { params: z.object({ page: z.coerce.number().default(1) }) } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.message).toContain("'page'")
    })

    it('reports required and omissible stray keys separately', async () => {
      const results = await run([
        route({
          path: '/posts/:id',
          schemas: { params: z.object({ postId: z.coerce.number(), slug: z.string().optional() }) },
        }),
      ])

      expect(results.map((r) => r.status).sort()).toEqual(['fail', 'warn'])
    })

    it('does not report a path parameter the schema leaves out', async () => {
      const results = await run([
        route({ path: '/posts/:id/comments/:commentId', schemas: { params: z.object({ id: z.coerce.number() }) } }),
      ])

      expect(results.every((r) => r.status === 'pass')).toBe(true)
    })

    // A pipeline runs both stages: the first accepts a missing value, the
    // second rejects it, so the request really does 400. Reading only one
    // side of the pipe — which the type renderer's presence walker does,
    // because it is answering a different question — would file this as
    // advice.
    it('treats a piped key its second stage rejects as required', async () => {
      const results = await run([
        route({
          path: '/posts/:id',
          schemas: { params: z.object({ postId: z.string().optional().pipe(z.string()) }) },
        }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
    })

    it('looks through wrappers to find the object', async () => {
      const results = await run([
        route({
          path: '/posts/:id',
          schemas: { params: z.object({ postId: z.coerce.number() }).readonly() },
        }),
      ])

      expect(results[0]?.status).toBe('fail')
    })

    // `nullable` is in the shared wrapper vocabulary, so this walk must look
    // through it for the same reason every sibling walker does: two walkers
    // disagreeing about membership is how one silently reports a different
    // set of keys than the other.
    it('looks through a nullable wrapper rather than calling it unreadable', async () => {
      const results = await run([
        route({ path: '/posts/:id', schemas: { params: z.object({ postId: z.string() }).nullable() } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain("'postId'")
    })
  })

  describe('unreadable schemas', () => {
    it('reports a skip rather than passing when the schema is not an object', async () => {
      const results = await run([
        route({ path: '/posts/:id', schemas: { params: z.string() } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.message).toContain('Skipped')
      expect(results[0]?.message).toContain("'string'")
    })

    it('reports a skip for a zod v3 schema', async () => {
      // Shaped like v3 rather than pulled from zod@3: `_def.typeName` is the
      // marker `isZod3Schema` reads, and installing a second zod to produce
      // one would test the installer, not this branch.
      const v3ish = { _def: { typeName: 'ZodObject' }, shape: { postId: {} } }
      const results = await run([
        route({ path: '/posts/:id', schemas: { params: v3ish as never } }),
      ])

      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.message).toContain('zod v3')
    })
  })

  describe('model bindings', () => {
    it('fails on a bind key the path does not declare', async () => {
      const results = await run([
        route({ path: '/posts/:id', bindings: { slug: 'Post' } }),
      ])

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain("'slug'")
      expect(results[0]?.message).toContain('No model binding found')
    })

    it('accepts a bind key the path declares', async () => {
      const results = await run([
        route({ path: '/posts/:id', bindings: { id: 'Post' } }),
      ])

      expect(results[0]?.status).toBe('pass')
    })
  })

  // The linchpin: both facts this check depends on are properties of the real
  // Router, not of hand-built definitions. `definitions()` reports the *joined*
  // path, so a group prefix supplies parameters the call site's own path string
  // does not; and route-level `bind` entries reach a definition without being
  // filtered by path parameter, which is the only reason a stray one is
  // visible here at all.
  describe('against a real Router', () => {
    class Post {
      static findOrFail() {
        return Promise.resolve({})
      }
    }

    it('counts a group prefix as declaring its parameters', async () => {
      const router = new Router()
      router.group('/authors/:authorId', (grouped) => {
        grouped.get('/posts/:id', {
          params: z.object({ authorId: z.coerce.number(), id: z.coerce.number() }),
          bind: { id: Post },
        }, controller)
      })

      const results = await run(router.definitions())

      expect(results.every((r) => r.status === 'pass')).toBe(true)
    })

    it('surfaces a stray route-level bind through definitions()', async () => {
      const router = new Router()
      router.get('/posts/:id', { bind: { slug: Post } }, controller)

      const results = await run(router.definitions())

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('fail')
      expect(results[0]?.message).toContain("'slug'")
    })

    it('leaves a router-level bind alone, which applies only where the path matches', async () => {
      const router = new Router()
      router.bind('id', Post)
      router.get('/posts/:id', controller)
      router.get('/health', controller)

      const results = await run(router.definitions())

      expect(results.every((r) => r.status === 'pass')).toBe(true)
    })
  })

  describe('loading', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'guren-route-contracts-'))
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    it('contributes nothing when the app has no routes file', async () => {
      expect(await checkRouteContracts({ cwd: tempDir })).toEqual([])
    })

    it('reports a skip when the routes file throws, rather than reading as clean', async () => {
      await writeWorkspaceFiles(tempDir, { 'routes/web.ts': 'throw new Error("boom")\n' })

      const results = await checkRouteContracts({ cwd: tempDir })

      expect(results).toHaveLength(1)
      expect(results[0]?.status).toBe('warn')
      expect(results[0]?.message).toContain('failed to load')
      expect(results[0]?.message).toContain('boom')
    })
  })
})
