import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDefaultDocsDir } from '../../app/Services/FsDocsStore.js'

describe('resolveDefaultDocsDir', () => {
  const repoRoot = resolve(import.meta.dirname, '../../..')

  it('finds the repository docs when running from a bundled SSR chunk', () => {
    const docsDir = resolveDefaultDocsDir({
      importMetaDir: resolve(repoRoot, 'web/dist/server/chunks'),
      cwd: resolve(repoRoot, 'web'),
    })

    expect(docsDir).toBe(resolve(repoRoot, 'docs'))
  })

  it("skips the app's own docs bundle, which holds no locale directory", () => {
    const docsDir = resolveDefaultDocsDir({
      importMetaDir: resolve(repoRoot, 'web/app/Services'),
      cwd: resolve(repoRoot, 'web/docs/adr'),
    })

    expect(docsDir).toBe(resolve(repoRoot, 'docs'))
  })
})
