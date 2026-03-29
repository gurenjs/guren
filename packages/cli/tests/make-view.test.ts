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
})
