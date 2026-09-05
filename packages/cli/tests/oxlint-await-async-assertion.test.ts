import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { lintFixture } from './helpers'

// The rule is exercised through the real oxlint binary rather than by calling
// `create()` with a hand-built AST: what has to hold is that the file the
// config points at loads as a plugin and reports on the AST oxlint hands it.

const plugin = resolve(import.meta.dir, '../src/oxlint/await-async-assertion.js')

/** Lines of `source` the rule reports, in the order oxlint prints them. */
function reportedLines(source: string): number[] {
  const stdout = lintFixture({ config: { jsPlugins: [plugin], rules: { 'guren/await-async-assertion': 'error' } }, file: 'case.test.ts', source })
  return [...stdout.matchAll(/^case\.test\.ts:(\d+):\d+: .*guren\(await-async-assertion\)/gm)].map((m) => Number(m[1]))
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

  test('reports the promise discarded through void, forEach, or an await on the wrong node', () => {
    const lines = reportedLines(`import { expect, test } from 'bun:test'
const p = () => Promise.reject(new Error('x'))
test('void', async () => {
  void expect(p()).rejects.toThrow('x')
})
test('forEach throws the matcher promise away', async () => {
  ;[1, 2].forEach(() => expect(p()).rejects.toThrow('x'))
})
test('await on the expect() result, not on the matcher', async () => {
  ;(await expect(p())).rejects.toThrow('x')
})
test('non-null and optional chaining', async () => {
  expect(p())!.rejects.toThrow('x')
  expect(p())?.rejects.toThrow('x')
})
`)
    expect(lines).toEqual([4, 7, 10, 13, 14])
  })

  test('follows expect through an import alias and a namespace import', () => {
    const lines = reportedLines(`import { expect as verify, test } from 'bun:test'
import * as t from 'bun:test'
const p = () => Promise.reject(new Error('x'))
test('alias', async () => {
  verify(p()).rejects.toThrow('x')
})
test('namespace', async () => {
  t.expect(p()).rejects.toThrow('x')
})
`)
    expect(lines).toEqual([5, 8])
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
  await Promise.all([1, 2].map(() => expect(p()).rejects.toThrow('x')))
})
test('plain matcher', () => {
  expect(1).toBe(1)
})
`)
    expect(lines).toEqual([])
  })

  test('only a chain rooted at expect counts, and a file defining its own expect is left alone', () => {
    const lines = reportedLines(`declare const client: { rejects: { record(): void } }
declare function expect(value: unknown): { rejects: { toThrow(): Promise<void> } }
client.rejects.record()
expect(1).rejects.toThrow()
`)
    expect(lines).toEqual([4])

    const dsl = reportedLines(`function expect(job: string) {
  return { rejects: { record: () => undefined } }
}
expect('job').rejects.record()
`)
    expect(dsl).toEqual([])
  })
})
