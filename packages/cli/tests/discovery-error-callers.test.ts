import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { createTempWorkspace, runCliBinCaptured, writeWorkspaceFiles } from './helpers'

// The failing read is injected rather than made with chmod, which a privileged runner ignores.
const deniedReads = (dirs: string[]) => `
import { mock } from 'bun:test'
import * as fs from 'node:fs/promises'
import { resolve } from 'node:path'
const original = { ...fs }
const denied = new Set(${JSON.stringify(dirs)}.map((dir) => resolve(dir)))
mock.module('node:fs/promises', () => ({ ...original, readdir: async (path, options) => {
  if (denied.has(String(path))) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
  return original.readdir(path, options)
} }))
`

const PLAN = {
  planVersion: 1,
  title: 'Unreadable sections',
  summary: 'A plan whose side effects and policy sit in directories that will not open.',
  locale: 'en',
  scope: { goals: [], nonGoals: [] },
  models: [{ id: 'm', change: { kind: 'existing' }, name: 'Post', table: 'posts', columns: [], relationships: [], fillable: [] }],
  policies: [{ id: 'pol', change: { kind: 'drop' }, name: 'PostPolicy', model: 'm', abilities: [{ name: 'delete', rule: 'r' }] }],
  sideEffects: [
    { id: 'fx.add', change: { kind: 'add' }, kind: 'job', name: 'SendDigest', trigger: 'hourly', description: 'd' },
    { id: 'fx.drop', change: { kind: 'drop' }, kind: 'job', name: 'OldDigest', trigger: 'hourly', description: 'd' },
  ],
}

describe('directory discovery failures in plan:status and doctor --next', () => {
  test('plan:status blocks a policy or side effect whose directory would not open, rather than reading it absent', async () => {
    const workspace = await createTempWorkspace('guren-discovery-plan-status-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'deny.ts': deniedReads(['app/Policies/admin', 'app/Jobs/billing']),
        'unreadable.plan.json': JSON.stringify(PLAN),
        'app/Policies/admin/PostPolicy.ts': 'export class PostPolicy {}\n',
        'app/Jobs/billing/SendDigest.ts': 'export class SendDigest {}\n',
      })
      const result = await runCliBinCaptured(['plan:status', 'unreadable.plan.json', '--json'], workspace.dir,
        { preload: join(workspace.dir, 'deny.ts') })

      expect(result.exitCode).toBe(0)
      // From the report's first line, so an info line the loader prints ahead of it cannot break the parse.
      const elements: Array<{ id: string; state: string; reason?: string }> = JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n'))).elements
      const judged = Object.fromEntries(elements.map((element) => [element.id, element]))
      expect(judged['pol']).toMatchObject({ state: 'blocked', reason: expect.stringContaining('app/Policies/admin would not open') })
      for (const id of ['fx.add', 'fx.drop']) {
        expect(judged[id]).toMatchObject({ state: 'blocked', reason: expect.stringContaining('app/Jobs/billing would not open') })
      }
    } finally {
      await workspace.cleanup()
    }
  })

  test('doctor --next names an unreadable directory instead of suggesting from an empty scan', async () => {
    const workspace = await createTempWorkspace('guren-discovery-doctor-next-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'deny.ts': deniedReads(['app/Http/Controllers/admin']),
        'package.json': JSON.stringify({ name: 'app', private: true }),
        'app/Http/Controllers/PostController.ts': 'export class PostController {}\n',
        'app/Http/Controllers/admin/UserController.ts': 'export class UserController {}\n',
        // The app's only test sits in the unreadable directory, so an empty scan would report no test foundation.
        'app/Http/Controllers/admin/UserController.test.ts': "test('x', () => {})\n",
      })
      const result = await runCliBinCaptured(['doctor', '--next', '--json', '--no-introspect'], workspace.dir,
        { preload: join(workspace.dir, 'deny.ts') })

      const steps: Array<{ title: string; description: string; filePath?: string }> = JSON.parse(result.stdout).nextSteps
      const incomplete = steps.filter((step) => step.title === 'Scan incomplete')
      expect(incomplete).toEqual([expect.objectContaining({ filePath: 'app/Http/Controllers/admin', description: expect.stringContaining('permission denied') })])
      const titles = steps.map((step) => step.title)
      expect(titles).not.toContain('Install test infrastructure')
      expect(titles).not.toContain('Confirm test coverage for PostController')
      expect(titles).not.toContain('Run the security audit')
    } finally {
      await workspace.cleanup()
    }
  })
})
