import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { isRawEnvKey } from '@guren/core'
import { lintFixture } from './helpers'

// Through the real oxlint binary, like the sibling rules. The rule judges the file's
// directory relative to the lint's cwd, so each fixture gets its own app root.

const plugin = resolve(import.meta.dir, '../src/oxlint/unvalidated-env-read.js')

function reportedLines(file: string, source: string): number[] {
  const dir = mkdtempSync(join(tmpdir(), 'guren-oxlint-env-read-'))
  try {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    const output = lintFixture({
      cwd: dir,
      config: { jsPlugins: [plugin], rules: { 'guren-unvalidated-env-read/no-unvalidated-env-read': 'error' } },
      file,
      source,
    })
    return [...output.matchAll(/^[^:\n]+:(\d+):\d+: .*no-unvalidated-env-read/gmu)].map((match) => Number(match[1]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('guren/no-unvalidated-env-read', () => {
  test.each(['app/Mail/Mailer.ts', 'config/mail.ts', 'routes/web.ts', 'src/app.ts'])('reports a declared-key read in %s', (file) => {
    expect(reportedLines(file, `const host = process.env.SMTP_HOST
const key = process.env['RESEND_API_KEY']
const typed = (process.env as Record<string, string | undefined>).APP_URL
`)).toEqual([1, 2, 3])
  })

  test.each(['bin/serve.ts', 'drizzle.config.ts', 'tests/app.test.ts'])('leaves %s alone, which runs outside an application', (file) => {
    expect(reportedLines(file, 'const port = process.env.PORT\n')).toEqual([])
  })

  test('leaves a read it cannot name alone', () => {
    expect(reportedLines('src/app.ts', `const name = 'APP_URL'
const dynamic = process.env[name]
const whole = process.env
`)).toEqual([])
  })

  test('exempts exactly the keys @guren/core keeps as raw reads', () => {
    const keys = ['NODE_ENV', 'GUREN_MCP', 'GUREN_TESTING', 'NODE_OPTIONS', 'GUREN', 'APP_URL']
    const source = keys.map((key) => `const v${keys.indexOf(key)} = process.env.${key}\n`).join('')

    const expected = keys.flatMap((key, index) => (isRawEnvKey(key) ? [] : [index + 1]))
    expect(expected).toEqual([4, 5, 6])
    expect(reportedLines('src/app.ts', source)).toEqual(expected)
  })
})
