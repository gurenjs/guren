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

  // `kebabCase()` preserves `/` and `.`, so the scaffold writer's containment
  // check is all that stands between the raw name and a write outside the project.
  it('refuses a name whose file name escapes the output directory', async () => {
    const workspace = await createTempWorkspace('guren-cli-route-escape-')
    try {
      await expect(makeRoute('../../../../tmp/evil', { force: true })).rejects.toThrow(
        'resolves outside the project root',
      )
    } finally {
      await workspace.cleanup()
    }
  })

  // The controller name has to be the one make:feature generates: stripping a
  // lone trailing `s` gave `CategorieController` for `categories`.
  it.each([
    ['categories', 'CategoryController'],
    ['boxes', 'BoxController'],
    ['news', 'NewController'],
  ])('names the controller for %s the way make:feature does', async (name, controller) => {
    const workspace = await createTempWorkspace('guren-cli-route-plural-')
    try {
      const content = await readFile(await makeRoute(name), 'utf8')
      expect(content).toContain(controller)
    } finally {
      await workspace.cleanup()
    }
  })
})
