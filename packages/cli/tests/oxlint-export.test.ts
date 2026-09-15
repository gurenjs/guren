import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertWorkspaceBuilt, lintFixture, linkWorkspacePackage } from './helpers'

// The `@guren/cli/oxlint` subpath is what an app's .oxlintrc.json names, so it is
// exercised the way oxlint resolves it: a bare specifier through node_modules,
// against the built dist (the same boundary the cli tests cross for @guren/server).

const repoRoot = resolve(import.meta.dir, '../../..')
assertWorkspaceBuilt([join(repoRoot, 'packages/cli/dist/oxlint/index.js')])

describe('@guren/cli/oxlint', () => {
  test('loads as a bare specifier and carries every rule family under the guren name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guren-oxlint-export-'))
    try {
      await linkWorkspacePackage('cli', dir)
      // Under src/, where guren/no-unvalidated-env-read applies.
      mkdirSync(join(dir, 'src'))
      const output = lintFixture({
        cwd: dir,
        config: {
          jsPlugins: ['@guren/cli/oxlint'],
          rules: {
            'guren/comment-banner': 'error',
            'guren/await-async-assertion': 'error',
            'guren/no-nullish-env-default': 'error',
            'guren/no-unvalidated-env-read': 'error',
          },
        },
        file: 'src/case.ts',
        source: `import { expect, test } from 'bun:test'\n// ---- banner ----\ntest('x', async () => {\n  expect(Promise.resolve(1)).resolves.toBe(1)\n})\nconst store = process.env.CACHE_STORE ?? 'memory'\n`,
      })

      expect(output).toContain('src/case.ts:2:1:')
      expect(output).toContain('guren(comment-banner)')
      expect(output).toContain('src/case.ts:4:3:')
      expect(output).toContain('guren(await-async-assertion)')
      expect(output).toContain('src/case.ts:6:15:')
      expect(output).toContain('guren(no-nullish-env-default)')
      expect(output).toContain('guren(no-unvalidated-env-read)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
