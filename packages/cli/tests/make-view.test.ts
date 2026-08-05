import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createTempWorkspace } from './helpers'
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
