import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { lintFixture } from './helpers'

// Exercised through the real oxlint binary, like the sibling rules: what has to
// hold is that the plugin loads and reports on the AST oxlint hands it.

const plugin = resolve(import.meta.dir, '../src/oxlint/nullish-env-default.js')

function lint(source: string): string {
  return lintFixture({
    config: { jsPlugins: [plugin], rules: { 'guren-nullish-env-default/no-nullish-env-default': 'error' } },
    file: 'case.ts',
    source,
  })
}

/** Lines of `source` the rule reports, in the order oxlint prints them. */
function reportedLines(source: string): number[] {
  return [...lint(source).matchAll(/^case\.ts:(\d+):\d+: .*no-nullish-env-default/gm)].map((m) => Number(m[1]))
}

describe('guren/no-nullish-env-default', () => {
  test('reports a non-empty literal fallback, however the read is spelled', () => {
    expect(reportedLines(`const a = process.env.CACHE_STORE ?? 'memory'
const b = process.env['SESSION_DRIVER'] ?? 'database'
const c = Number(process.env.SMTP_PORT ?? 587)
const d = (process.env.HOST as string | undefined) ?? '0.0.0.0'
const e = process.env.APP_URL! ?? 'http://localhost'
const f = (process.env.PORT satisfies string | undefined) ?? '3333'
const g = (<string | undefined>process.env.APP_ENV) ?? 'development'
`)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  test('leaves alone the shapes where the operator cannot be the bug', () => {
    expect(reportedLines(`const a = process.env.SMTP_USER ?? ''
const b = process.env.PORT ?? fallbackPort
const c = process.env.CACHE_STORE || 'memory'
const d = process.env.NODE_ENV
const e = options.dir ?? './data'
`)).toEqual([])
  })

  test('reports a chain once, and names every read a blank value could win from', () => {
    const source = `const r = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1'\n`
    expect(reportedLines(source)).toEqual([1])
    // `??` is left-associative, so a blank AWS_REGION wins first; naming only
    // the tail would point at a variable that is neither blank nor the cause.
    expect(lint(source)).toContain('keeps a blank `AWS_REGION=` or `AWS_DEFAULT_REGION=` as \'\'')
  })

  test('quotes the expression as written, so the message is actionable', () => {
    expect(lint(`const a = process.env.CACHE_STORE ?? 'memory'\n`))
      .toContain("`process.env.CACHE_STORE ?? 'memory'` keeps a blank `CACHE_STORE=` as ''")
  })
})
