import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { lintFixture } from './helpers'

// Exercised through the real oxlint binary, like the sibling rules: what has to
// hold is that the plugin loads and reports on the AST oxlint hands it.

const plugin = resolve(import.meta.dir, '../src/oxlint/nullish-env-default.js')

/** Lines of `source` the rule reports, in the order oxlint prints them. */
function reportedLines(source: string): number[] {
  const stdout = lintFixture({
    config: { jsPlugins: [plugin], rules: { 'guren-nullish-env-default/no-nullish-env-default': 'error' } },
    file: 'case.ts',
    source,
  })
  return [...stdout.matchAll(/^case\.ts:(\d+):\d+: .*no-nullish-env-default/gm)].map((m) => Number(m[1]))
}

describe('guren/no-nullish-env-default', () => {
  test('reports a non-empty literal fallback, however the read is spelled', () => {
    expect(reportedLines(`const a = process.env.CACHE_STORE ?? 'memory'
const b = process.env['SESSION_DRIVER'] ?? 'database'
const c = Number(process.env.SMTP_PORT ?? 587)
const d = (process.env.HOST as string | undefined) ?? '0.0.0.0'
const e = process.env.APP_URL! ?? 'http://localhost'
`)).toEqual([1, 2, 3, 4, 5])
  })

  test('leaves alone the shapes where the operator cannot be the bug', () => {
    // `?? ''` is identical under either operator; a non-literal fallback cannot
    // be judged from syntax; `||` is already the fix; a plain read has no default.
    expect(reportedLines(`const a = process.env.SMTP_USER ?? ''
const b = process.env.PORT ?? fallbackPort
const c = process.env.CACHE_STORE || 'memory'
const d = process.env.NODE_ENV
const e = options.dir ?? './data'
declare const fallbackPort: string
declare const options: { dir?: string }
`)).toEqual([])
  })

  test('reports the outer read of a chain, where the literal actually lands', () => {
    // `AWS_REGION ?? AWS_DEFAULT_REGION ?? 'us-east-1'`: the inner `??` has a
    // non-literal fallback, so only the one holding the literal is reported.
    expect(reportedLines(`const r = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1'
`)).toEqual([1])
  })

  test('names the variable and the fallback, so the message is actionable', () => {
    const stdout = lintFixture({
      config: { jsPlugins: [plugin], rules: { 'guren-nullish-env-default/no-nullish-env-default': 'error' } },
      file: 'case.ts',
      source: `const a = process.env.CACHE_STORE ?? 'memory'\n`,
    })
    expect(stdout).toContain('`process.env.CACHE_STORE ?? "memory"` keeps a blank `CACHE_STORE=` as \'\'')
  })
})
