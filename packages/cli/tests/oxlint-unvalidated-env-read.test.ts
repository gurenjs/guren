import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { isRawEnvKey } from '@guren/core'
import { lintFixture } from './helpers'

// Through the real oxlint binary, like the sibling rules.

const plugin = resolve(import.meta.dir, '../src/oxlint/unvalidated-env-read.js')

function reportedLines(source: string): number[] {
  const output = lintFixture({
    config: { jsPlugins: [plugin], rules: { 'guren-unvalidated-env-read/no-unvalidated-env-read': 'error' } },
    file: 'case.ts',
    source,
  })
  return [...output.matchAll(/^case\.ts:(\d+):\d+: .*no-unvalidated-env-read/gmu)].map((match) => Number(match[1]))
}

describe('guren/no-unvalidated-env-read', () => {
  test('reports a named read, however it is spelled', () => {
    expect(reportedLines(`const host = process.env.SMTP_HOST
const key = process.env['RESEND_API_KEY']
const typed = (process.env as Record<string, string | undefined>).APP_URL
`)).toEqual([1, 2, 3])
  })

  test('leaves a read it cannot name alone', () => {
    expect(reportedLines(`const name = 'APP_URL'
const dynamic = process.env[name]
const whole = process.env
`)).toEqual([])
  })

  test('exempts exactly the keys @guren/core keeps as raw reads', () => {
    const keys = ['NODE_ENV', 'GUREN_MCP', 'GUREN_TESTING', 'NODE_OPTIONS', 'GUREN', 'APP_URL']
    const source = keys.map((key, index) => `const v${index} = process.env.${key}\n`).join('')

    expect(reportedLines(source)).toEqual(keys.flatMap((key, index) => (isRawEnvKey(key) ? [] : [index + 1])))
  })
})
