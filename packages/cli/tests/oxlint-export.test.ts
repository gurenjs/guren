import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The `@guren/cli/oxlint` subpath is what an app's .oxlintrc.json names, so it is
// exercised the way oxlint resolves it: a bare specifier through node_modules,
// against the built dist (the same boundary the cli tests cross for @guren/server).

const repoRoot = resolve(import.meta.dir, '../../..')
const oxlint = join(repoRoot, 'node_modules', '.bin', 'oxlint')

function lint(source: string, rules: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'guren-oxlint-export-'))
  try {
    mkdirSync(join(dir, 'node_modules', '@guren'), { recursive: true })
    symlinkSync(join(repoRoot, 'packages', 'cli'), join(dir, 'node_modules', '@guren', 'cli'))
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ jsPlugins: ['@guren/cli/oxlint'], rules }))
    writeFileSync(join(dir, 'case.ts'), source)
    const result = Bun.spawnSync([oxlint, '-c', '.oxlintrc.json', '-A', 'all', ...Object.keys(rules).flatMap((r) => ['-D', r]), '--format', 'unix', 'case.ts'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = result.stderr.toString()
    if (stderr.trim() !== '') throw new Error(`oxlint wrote to stderr:\n${stderr}`)
    return result.stdout.toString()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('@guren/cli/oxlint', () => {
  test('loads as a bare specifier and carries both rule families under the guren name', () => {
    const output = lint(
      `import { expect, test } from 'bun:test'\n// ---- banner ----\ntest('x', async () => {\n  expect(Promise.resolve(1)).resolves.toBe(1)\n})\n`,
      { 'guren/comment-banner': 'error', 'guren/await-async-assertion': 'error' },
    )
    expect(output).toContain('case.ts:2:1:')
    expect(output).toContain('guren(comment-banner)')
    expect(output).toContain('case.ts:4:3:')
    expect(output).toContain('guren(await-async-assertion)')
  })
})
