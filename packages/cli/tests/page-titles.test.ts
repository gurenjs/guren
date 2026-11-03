import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = join(import.meta.dir, '../../..')
const TEMPLATE_ROOTS = ['packages/cli/templates/scaffold', 'packages/create-app/templates']

const pages = TEMPLATE_ROOTS.flatMap((root) =>
  [...new Bun.Glob('**/pages/**/*.tsx').scanSync({ cwd: join(repoRoot, root) })].map((path) => `${root}/${path}`),
).sort()

// An Inertia visit to a page with no <Head> leaves the document without a title of its own (axe's document-title).
describe('every page a scaffold ships sets its document title', () => {
  it('finds the scaffolded pages', () => {
    expect(pages.length).toBeGreaterThan(10)
    expect(pages).toContain('packages/cli/templates/scaffold/auth/resources/js/pages/dashboard/Index.tsx')
  })

  it.each(pages)('%s', async (path) => {
    const source = await readFile(join(repoRoot, path), 'utf8')
    expect(source).toMatch(/^import \{[^}]*\bHead\b[^}]*\} from '@inertiajs\/react'$/m)
    expect(source).toMatch(/<Head\s+title=/)
  })
})
