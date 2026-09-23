import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runCheckFixes } from '../src/check-fix'
import { check, commandFix, formatFixCommand, pendingFixes, type CheckReport, type CheckResult } from '../src/check-result'
import { writeSpecArtifacts } from '../src/spec-generate'
import type { CapturedExec } from '../src/subprocess'
import { createTempWorkspace, runCliBinCaptured } from './helpers'

function report(checks: CheckResult[]): CheckReport {
  return { cwd: '/app', checks, passCount: 0, warnCount: 0, failCount: 0 }
}

function finding(key: string, args: string[], status: CheckResult['status'] = 'warn'): CheckResult {
  return { ...check(key, key, status, `${key} is stale.`), fix: commandFix(...args) }
}

describe('formatFixCommand', () => {
  it('prints the arguments after bunx guren', () => {
    expect(formatFixCommand(commandFix('codegen', '--routes', 'routes/api.ts'))).toBe('bunx guren codegen --routes routes/api.ts')
  })

  it('quotes an argument a shell would split', () => {
    expect(formatFixCommand(commandFix('codegen', '--routes', "routes/it's api.ts"))).toBe(
      `bunx guren codegen --routes 'routes/it'\\''s api.ts'`,
    )
  })
})

describe('pendingFixes', () => {
  it('lists each distinct fix once, in report order', () => {
    const fixes = pendingFixes(report([
      finding('manifest:routes', ['codegen']),
      finding('spec-drift:er.md', ['spec:generate'], 'fail'),
      finding('manifest:data', ['codegen']),
    ]))

    expect(fixes.map((fix) => fix.args)).toEqual([['codegen'], ['spec:generate']])
  })

  it('skips a passing result that still carries a fix', () => {
    expect(pendingFixes(report([finding('manifest:routes', ['codegen'], 'pass')]))).toEqual([])
  })

  it('tells codegen with a routes file apart from a bare codegen', () => {
    const fixes = pendingFixes(report([
      finding('manifest:routes', ['codegen']),
      finding('manifest:agents', ['codegen', '--routes', 'routes/api.ts']),
    ]))

    expect(fixes).toHaveLength(2)
  })
})

describe('runCheckFixes', () => {
  it('runs each fix once through the CLI entry, from the report root', async () => {
    const calls: Array<{ command: string[]; cwd: string }> = []
    const exec: CapturedExec = async (command, cwd) => {
      calls.push({ command, cwd })
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    const runs = await runCheckFixes(
      report([finding('manifest:routes', ['codegen']), finding('manifest:data', ['codegen'])]),
      exec,
    )

    expect(runs).toEqual([{ command: 'bunx guren codegen', ok: true }])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe('/app')
    expect(calls[0]?.command.at(-1)).toBe('codegen')
  })

  it('keeps the output of a failed run and still runs the rest', async () => {
    const exec: CapturedExec = async (command) =>
      command.at(-1) === 'codegen'
        ? { exitCode: 1, stdout: 'reading routes\n', stderr: 'Error: routes/web.ts failed to load\n' }
        : { exitCode: 0, stdout: '', stderr: '' }

    const runs = await runCheckFixes(
      report([finding('manifest:routes', ['codegen']), finding('spec-drift:er.md', ['spec:generate'], 'fail')]),
      exec,
    )

    expect(runs).toEqual([
      { command: 'bunx guren codegen', ok: false, output: ['reading routes', 'Error: routes/web.ts failed to load'] },
      { command: 'bunx guren spec:generate', ok: true },
    ])
  })

  it('runs nothing when no finding carries a fix', async () => {
    const exec: CapturedExec = async () => {
      throw new Error('nothing should run')
    }

    expect(await runCheckFixes(report([check('test:PostController', 'tests', 'warn', 'missing')]), exec)).toEqual([])
  })
})

describe('guren check --fix', () => {
  it('regenerates a drifted spec view and reports the check that follows', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-fix-')
    try {
      const dir = workspace.dir
      await mkdir(join(dir, 'db'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(dir, 'db/schema.ts'),
        `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`,
        'utf8',
      )
      await writeSpecArtifacts({ cwd: dir })
      const committed = await readFile(join(dir, 'docs/spec/er.md'), 'utf8')
      await rm(join(dir, 'docs/spec/er.md'))

      const { stdout, exitCode } = await runCliBinCaptured(['check', '--spec', '--fix', '--json', '--app', dir], dir)
      const result = JSON.parse(stdout) as CheckReport

      expect(exitCode).toBe(0)
      expect(result.fixes).toEqual([{ command: 'bunx guren spec:generate', ok: true }])
      expect(result.checks.find((c) => c.key === 'spec-drift:er.md')?.status).toBe('pass')
      expect(await readFile(join(dir, 'docs/spec/er.md'), 'utf8')).toBe(committed)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports no fixes when nothing needed one', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-fix-clean-')
    try {
      const { stdout } = await runCliBinCaptured(['check', '--spec', '--fix', '--json', '--app', workspace.dir], workspace.dir)

      expect((JSON.parse(stdout) as CheckReport).fixes).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })
})
