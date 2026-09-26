import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createTempWorkspace, runCliBinCaptured, writeWorkspaceFiles } from './helpers'

const commands = [
  { args: ['check', '--arch'], code: 1, field: 'checks' },
  { args: ['check', '--ci', '--no-introspect'], code: 1, field: 'checks' },
  { args: ['check', '--no-introspect'], code: 0, field: 'checks' },
  { args: ['audit', '--no-deps', '--no-introspect'], code: 1, field: 'findings' },
]

// Inject only the failing directory read, so this also exercises recursion on
// privileged test runners where chmod cannot make a directory unreadable.
const deniedRead = `
import { mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import { resolve } from 'node:path'
const original = { ...fs }
const denied = resolve('app/denied')
mock.module('node:fs/promises', () => ({ ...original, readdir: async (path, options) => {
  if (String(path) === denied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
  return original.readdir(path, options)
} }))
`

const archConfig = `export default {
  layers: { domain: 'app/**', http: 'routes/**' },
  rules: [{ from: 'domain', disallow: ['http'] }],
}`

describe('directory discovery failures in diagnostic commands', () => {
  for (const command of commands) {
    for (const failure of ['permission', 'not-directory'] as const) {
      test(`${command.args.join(' ')} reports ${failure} in JSON`, async () => {
        const workspace = await createTempWorkspace('guren-discovery-boundary-')
        try {
          await writeWorkspaceFiles(workspace.dir, failure === 'permission' ? {
            'deny.ts': deniedRead,
            'guren.arch.ts': archConfig,
            'app/denied/Hidden.ts': 'export class Hidden {}',
          } : { modules: 'not a directory' })
          const result = await runCliBinCaptured([...command.args, '--json'], workspace.dir,
            failure === 'permission' ? { preload: join(workspace.dir, 'deny.ts') } : {})
          expect(result.exitCode).toBe(command.code)
          const report = JSON.parse(result.stdout)
          expect(report.failCount).toBe(1)
          expect(report.passCount).toBe(0)
          expect(report[command.field]).toEqual([expect.objectContaining({
            key: 'discovery:read', title: 'Scan incomplete', status: 'fail', evidence: 'none',
            filePath: failure === 'permission' ? 'app/denied' : 'modules',
          })])
          expect(report[command.field][0].message).toContain(failure === 'permission' ? 'permission denied' : 'ENOTDIR')
          expect(result.stderr).not.toContain('Unhandled')
          if (command.field === 'findings') {
            expect(report.routesAnalyzed).toBe(false)
            expect(report.csrfExemptionScan.status).toBe('partial')
          }
        } finally {
          await workspace.cleanup()
        }
      })
    }
  }

  for (const args of [['check', '--arch'], ['audit', '--no-deps', '--no-introspect']]) {
    test(`${args[0]} renders an incomplete scan in text`, async () => {
      const workspace = await createTempWorkspace('guren-discovery-text-')
      try {
        await writeWorkspaceFiles(workspace.dir, { modules: 'not a directory' })
        const result = await runCliBinCaptured(args, workspace.dir)
        expect(result.exitCode).toBe(1)
        expect(result.stdout + result.stderr).toContain('Scan incomplete')
        expect(result.stdout + result.stderr).toContain('Could not read directory')
      } finally {
        await workspace.cleanup()
      }
    })

    test(`${args[0]} tolerates absent optional directories`, async () => {
      const workspace = await createTempWorkspace('guren-discovery-optional-')
      try {
        const result = await runCliBinCaptured([...args, '--json'], workspace.dir)
        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout).failCount).toBe(0)
      } finally {
        await workspace.cleanup()
      }
    })
  }
})
