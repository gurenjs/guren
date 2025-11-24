import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDefaultDocsDir } from '../../app/Services/DocsService.js'

describe('resolveDefaultDocsDir', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..')

  it('finds the repository docs when running from a bundled SSR chunk', () => {
    const docsDir = resolveDefaultDocsDir({
      importMetaDir: resolve(repoRoot, 'web/dist/server/chunks'),
      cwd: resolve(repoRoot, 'web'),
    })

    expect(docsDir).toBe(resolve(repoRoot, 'docs'))
  })
})
