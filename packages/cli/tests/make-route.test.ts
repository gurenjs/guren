import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createTempWorkspace } from './helpers'
import { makeRoute } from '../src/make-route'

describe('makeRoute', () => {
  it('creates a route group file with controller reference', async () => {
    const workspace = await createTempWorkspace('guren-cli-route-')
    try {
      const result = await makeRoute('posts')
      expect(result).toContain('routes/posts.ts')

      const content = await readFile(result, 'utf8')
      expect(content).toContain('import { Router }')
      expect(content).toContain('registerRoutes(router: Router)')
      expect(content).toContain("router.group('/posts'")
      expect(content).toContain('PostController')
      expect(content).toContain("@guren/core")
    } finally {
      await workspace.cleanup()
    }
  })
})
