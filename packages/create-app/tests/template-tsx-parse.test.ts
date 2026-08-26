import { describe, expect, it, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every blueprint .tsx must at least parse. The templates are excluded from
 * all typecheck projects (they resolve `@guren/*` from npm — see
 * common-pitfalls), and the blueprint tests assert selected strings, so
 * before this gate a syntax error in a template page only surfaced in the
 * multi-minute starter smokes.
 */
const templatesRoot = join(import.meta.dir, '../templates')

function collectTsx(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collectTsx(path))
    else if (entry.name.endsWith('.tsx')) found.push(path)
  }
  return found
}

const transpiler = new Bun.Transpiler({ loader: 'tsx' })

test('the parser actually rejects broken TSX', () => {
  expect(() => transpiler.transformSync('const <nonsense')).toThrow()
})

describe('blueprint template pages parse as TSX', () => {
  const files = collectTsx(templatesRoot)

  test('finds template TSX files', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(files.map((file) => [relative(templatesRoot, file)] as const))('%s', (rel) => {
    const source = readFileSync(join(templatesRoot, rel), 'utf8')
    expect(() => transpiler.transformSync(source)).not.toThrow()
  })
})
