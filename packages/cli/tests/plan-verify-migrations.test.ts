import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { realpath, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import type { PlanVerifyReport } from '../src/plan-verify'
import { createTempRoot, writeWorkspaceFiles } from './helpers'
import { approvePlanFile, createPlanVerifyApp, loadApprovedCommentsPlan, PLAN_VERIFY_APP_FILES as APP, waiveForTest } from './plan-fixture'

let ROOT: string
// The CLI does not install drizzle-kit; the example application pins the copy scaffolded apps get.
const WORKSPACE_DRIZZLE_KIT = resolve(import.meta.dir, '../../../examples/blog/node_modules/drizzle-kit')

const DATA = 'task/entity/model.comment/data'

const DRIZZLE_CONFIG = `import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: 'postgres://nobody:nothing@127.0.0.1:1/none' },
})
`

async function createApp(name: string, { drizzleKit = true } = {}): Promise<string> {
  const dir = await createPlanVerifyApp(join(ROOT, name), { ...APP, 'drizzle.config.ts': DRIZZLE_CONFIG })
  if (drizzleKit) await symlink(await realpath(WORKSPACE_DRIZZLE_KIT), join(dir, 'node_modules', 'drizzle-kit'), 'dir')
  return dir
}

/** The comments fixture, approved, with what its data step would find unlike the plan waived. */
async function writePlan(name: string): Promise<string> {
  const path = join(ROOT, name)
  await writeWorkspaceFiles(ROOT, { [name]: JSON.stringify(loadApprovedCommentsPlan()) })
  await approvePlanFile(path)
  await waiveForTest(path, ['column.comment.body', 'column.comment.postId', 'model.comment', 'model.post'])
  return path
}

function generateMigration(app: string): void {
  const result = Bun.spawnSync([process.execPath, join(app, 'node_modules/drizzle-kit/bin.cjs'), 'generate', '--config', 'drizzle.config.ts', '--name', 'init'], { cwd: app, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`drizzle-kit generate failed: ${result.stderr.toString()}${result.stdout.toString()}`)
}

describe('plan:verify on a data step', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    ROOT = await createTempRoot('guren-plan-verify-migrations-')
  })

  afterEach(() => {
    log.mockClear()
    process.exitCode = 0
  })

  afterAll(() => {
    log.mockRestore()
  })

  async function verify(plan: string, app: string): Promise<PlanVerifyReport> {
    log.mockClear()
    log.mockImplementation(() => {})
    await runCommand(builtinSubCommands['plan:verify'] as CommandDef, { rawArgs: [plan, '--app', app, '--json', '--step', DATA] })
    return JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as PlanVerifyReport
  }

  function migrate(report: PlanVerifyReport): PlanVerifyReport['steps'][number]['record']['commands'][number] {
    return report.steps[0]!.record.commands.find((command) => command.command === 'db:migrate')!
  }

  test('should fail a data step whose schema declares tables no migration creates', async () => {
    const app = await createApp('no-migration')
    const plan = await writePlan('no-migration.plan.json')

    const report = await verify(plan, app)

    expect(report.steps[0]!.record.outcome).toBe('failed')
    expect(migrate(report)).toMatchObject({ status: 'fail' })
    expect(migrate(report).reason).toContain('no migration covers')
    expect(migrate(report).findings.join('\n')).toContain('comments')
  })

  test('should fail a data step whose schema gained a column after the last migration', async () => {
    const app = await createApp('stale-migration')
    const plan = await writePlan('stale-migration.plan.json')
    generateMigration(app)
    await writeWorkspaceFiles(app, { 'db/schema.ts': `${APP['db/schema.ts']!.replace("  body: text('body'),\n", "  body: text('body'),\n  editedAt: timestamp('edited_at', { withTimezone: true }),\n")}` })

    const report = await verify(plan, app)

    expect(report.steps[0]!.record.outcome).toBe('failed')
    expect(migrate(report).findings.join('\n')).toContain('edited_at')
  })

  test('should run the migration once a migration covers the schema', async () => {
    const app = await createApp('covered')
    const plan = await writePlan('covered.plan.json')
    generateMigration(app)

    const report = await verify(plan, app)

    expect(migrate(report)).toMatchObject({ status: 'pass', label: 'bun run db:migrate' })
    expect(report.steps[0]!.record.outcome).toBe('verified')
  })

  test('should block, not pass, a data step where the application has no drizzle-kit to ask', async () => {
    const app = await createApp('no-drizzle-kit', { drizzleKit: false })
    const plan = await writePlan('no-drizzle-kit.plan.json')

    const report = await verify(plan, app)

    expect(migrate(report)).toMatchObject({ status: 'blocked' })
    expect(migrate(report).reason).toContain('drizzle-kit')
    expect(report.steps[0]!.record.outcome).toBe('blocked')
  })
})
