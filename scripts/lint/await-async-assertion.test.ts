import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// The rule is exercised through the real oxlint binary rather than by calling
// `create()` with a hand-built AST: what has to hold is that the file the
// config points at loads as a plugin and reports on the AST oxlint hands it.

const repoRoot = resolve(import.meta.dir, '../..')
const oxlint = join(repoRoot, 'node_modules', '.bin', 'oxlint')
const plugin = join(repoRoot, 'scripts', 'lint', 'await-async-assertion.js')

/** Lines of `source` the rule reports, in the order oxlint prints them. */
function reportedLines(source: string): number[] {
  const dir = mkdtempSync(join(tmpdir(), 'guren-await-async-assertion-'))
  try {
    writeFileSync(
      join(dir, '.oxlintrc.json'),
      JSON.stringify({ jsPlugins: [plugin], rules: { 'guren/await-async-assertion': 'error' } }),
    )
    writeFileSync(join(dir, 'case.test.ts'), source)
    const result = Bun.spawnSync(
      [oxlint, '-c', '.oxlintrc.json', '-A', 'all', '-D', 'guren/await-async-assertion', '--format', 'unix', 'case.test.ts'],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    if (stderr.trim() !== '') {
      throw new Error(`oxlint wrote to stderr:\n${stderr}`)
    }
    return [...stdout.matchAll(/^case\.test\.ts:(\d+):\d+: .*guren\(await-async-assertion\)/gm)].map((m) => Number(m[1]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('guren/await-async-assertion', () => {
  test('reports a bare .rejects / .resolves statement whatever the callback and the import', () => {
    const lines = reportedLines(`import { expect, test } from 'bun:test'
const p = () => Promise.reject(new Error('x'))
test('async rejects', async () => {
  expect(p()).rejects.toThrow('x')
})
test('sync rejects', () => {
  expect(p()).rejects.toThrow('x')
})
test('async resolves', async () => {
  expect(Promise.resolve(1)).resolves.toBe(1)
})
test('not the last statement', async () => {
  expect(p()).rejects.toThrow('x')
  expect(1).toBe(1)
})
test('negated', async () => {
  expect(p()).rejects.not.toThrow('y')
})
`)
    expect(lines).toEqual([4, 7, 10, 13, 17])
  })

  test('stays quiet once the promise is consumed', () => {
    const lines = reportedLines(`import { expect, test } from 'bun:test'
const p = () => Promise.reject(new Error('x'))
test('awaited', async () => {
  await expect(p()).rejects.toThrow('x')
})
test('returned', () => {
  return expect(p()).rejects.toThrow('x')
})
test('arrow body', () => expect(p()).rejects.toThrow('x'))
test('gathered', async () => {
  await Promise.all([expect(p()).rejects.toThrow('x'), expect(p()).rejects.toThrow('x')])
})
test('plain matcher', () => {
  expect(1).toBe(1)
})
`)
    expect(lines).toEqual([])
  })

  test('only a chain rooted at expect counts', () => {
    const lines = reportedLines(`declare const client: { rejects: { record(): void } }
declare function expect(value: unknown): { rejects: { toThrow(): Promise<void> } }
client.rejects.record()
expect(1).rejects.toThrow()
`)
    expect(lines).toEqual([4])
  })
})
