import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { API_ONLY_REFUSAL, createTempWorkspace, seedApiOnlyApp, seedShippedApiOnlyApp } from './helpers'
import { makeView } from '../src/make-view'

describe('makeView', () => {
  it('creates a view component with the expected name', async () => {
    const workspace = await createTempWorkspace('guren-cli-view-')
    try {
      const result = await makeView('admin/settings/Index')
      expect(result).toContain('resources/js/pages/admin/settings/Index.tsx')

      const content = await readFile(result, 'utf8')
      expect(content).toContain('const Index')
      expect(content).toContain('export default Index')
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps accepting a name with a space, the way pascalCase always has', async () => {
    const workspace = await createTempWorkspace('guren-cli-view-space-')
    try {
      const result = await makeView('admin/my page')

      expect(result).toContain('resources/js/pages/admin/my page.tsx')
      expect(await readFile(result, 'utf8')).toContain('const MyPage')
    } finally {
      await workspace.cleanup()
    }
  })

  // Refuses before the write; "cannot tell" is carried by the tests above, and
  // the predicate's own branches are pinned in blueprints.test.ts.
  it('refuses an API-only app, writing nothing', async () => {
    const workspace = await createTempWorkspace('guren-cli-view-api-only-')
    try {
      await seedApiOnlyApp(workspace.dir)

      await expect(makeView('posts/Index')).rejects.toThrow(API_ONLY_REFUSAL)

      expect(existsSync(join(workspace.dir, 'resources/js/pages/posts/Index.tsx'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  // The fixture above is only a reduction of what `create-guren-app` ships.
  it('refuses the api-only template as shipped', async () => {
    const workspace = await createTempWorkspace('guren-cli-view-api-only-shipped-')
    try {
      await seedShippedApiOnlyApp(workspace.dir)

      await expect(makeView('posts/Index')).rejects.toThrow(
        'guren make:view scaffolds a React page component',
      )
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects a name whose segments escape the page root', async () => {
    const workspace = await createTempWorkspace('guren-cli-view-traversal-')
    try {
      await expect(makeView('../../../../tmp/pwned', { force: true })).rejects.toThrow(
        'is a path traversal',
      )
      await expect(makeView('posts/../../../tmp/pwned', { force: true })).rejects.toThrow(
        'is a path traversal',
      )
    } finally {
      await workspace.cleanup()
    }
  })
})
