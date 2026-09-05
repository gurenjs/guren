import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../../..')

// The templates carry a copy of the config `guren add lint` writes: one file in
// two places, so a fresh app and an older app upgraded by hand get the same rules.
describe('template lint setup', () => {
  test.each(['default', 'api-only'])('%s ships the same .oxlintrc.json as guren add lint', async (template) => {
    const shipped = await readFile(join(repoRoot, 'packages/create-app/templates', template, '.oxlintrc.json'), 'utf8')
    const source = await readFile(join(repoRoot, 'packages/cli/templates/scaffold/lint/.oxlintrc.json'), 'utf8')
    expect(shipped).toBe(source)
  })

  test.each(['default', 'api-only'])('%s wires the lint scripts, the oxlint dev dependency, and a CI step', async (template) => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'packages/create-app/templates', template, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(manifest.scripts.lint).toBe('bunx oxlint')
    expect(manifest.scripts['lint:fix']).toBe('bunx oxlint --fix')
    // The range itself is audit:template-deps' business (it follows @guren/cli's peer).
    expect(manifest.devDependencies.oxlint).toMatch(/^~\d/)
    const ci = await readFile(join(repoRoot, 'packages/create-app/templates', template, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('run: bun run lint')
  })
})
