import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { parsePlanDocument } from '../src/plan-render'
import type { PlanStatusReport } from '../src/plan-status'
import type { PlanVerifyReport } from '../src/plan-verify'
import { planDigest, PLAN_STATE_GITIGNORE, PLAN_STATE_VERSION, type PlanStepRecord } from '../src/plan/state'
import { sha256 } from '../src/plan/verification'
import { linkWorkspaceCore, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan, PLAN_VERIFY_APP_FILES as APP, PLAN_VERIFY_SCHEMA as SCHEMA } from './plan-fixture'

// `bun test` fires no exit handler, so the roots earlier runs left are removed at the start.
// Each application has a directory of its own, since Bun keys an imported routes file on
// its path and a second test would read the first one's route graph back.
const ROOT_PREFIX = 'guren-plan-verify-command-'
let ROOT: string
const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')

const HTTP = 'task/entity/model.comment/http'
const DATA = 'task/entity/model.comment/data'

async function createApp(name: string, files: Record<string, string> = APP): Promise<string> {
  const dir = join(ROOT, name)
  await writeWorkspaceFiles(dir, files)
  await linkWorkspaceCore(dir)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(WORKSPACE_DRIZZLE, join(dir, 'node_modules', 'drizzle-orm'), 'dir')
  return dir
}

async function writePlan(name: string, document: unknown = loadCommentsPlan()): Promise<string> {
  await writeWorkspaceFiles(ROOT, { [name]: JSON.stringify(document) })
  return join(ROOT, name)
}

describe('plan:verify', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    const stale = (await readdir(tmpdir())).filter((name) => name.startsWith(ROOT_PREFIX))
    await Promise.all(stale.map((name) => rm(join(tmpdir(), name), { recursive: true, force: true })))
    ROOT = await mkdtemp(join(tmpdir(), ROOT_PREFIX))
  })

  afterEach(() => {
    log.mockClear()
    // Bun ignores `process.exitCode = undefined`, and a leaked 1 from the --ci test fails the whole run.
    process.exitCode = 0
  })

  afterAll(() => {
    log.mockRestore()
  })

  async function run(command: 'plan:verify' | 'plan:status', plan: string, app: string, ...flags: string[]): Promise<string> {
    log.mockClear()
    log.mockImplementation(() => {})
    await runCommand(builtinSubCommands[command] as CommandDef, { rawArgs: [plan, '--app', app, ...flags] })
    return log.mock.calls.map((call) => String(call[0])).join('\n')
  }

  async function verify(plan: string, app: string, ...flags: string[]): Promise<PlanVerifyReport> {
    return JSON.parse(await run('plan:verify', plan, app, '--json', ...flags)) as PlanVerifyReport
  }

  async function status(plan: string, app: string): Promise<PlanStatusReport> {
    return JSON.parse(await run('plan:status', plan, app, '--json')) as PlanStatusReport
  }

  function states(result: PlanStatusReport): Record<string, string> {
    return Object.fromEntries(result.elements.map((element) => [element.id, element.state]))
  }

  test('should run one step against the application, judge its behaviours from a real bun test, and record the result', async () => {
    const app = await createApp('http')
    const plan = await writePlan('http.plan.json')

    const result = await verify(plan, app, '--step', HTTP)

    expect(result.steps).toHaveLength(1)
    const [step] = result.steps
    expect(step!.stepId).toBe(HTTP)
    const { record } = step!
    expect(record.commands.map((command) => [command.command, command.status, command.label])).toEqual([
      ['codegen', 'pass', 'bun run codegen'],
      ['check', 'pass', 'guren check'],
      ['tests', 'pass', 'bun test tests/comments.test.ts'],
    ])
    expect(record.acceptance.map((behaviour) => behaviour.status)).toEqual(['passing', 'passing', 'passing', 'passing'])
    // The plan's destroy action, route, resource and policy are not written, so the step cannot verify.
    expect(record.outcome).toBe('incomplete')
    expect(record.incomplete).toEqual(expect.arrayContaining(['action.comments.destroy: planned', 'route.comments.destroy: planned', 'resource.comment: planned', 'policy.comment: planned']))
    // The store route is drifted, so nothing of it would be lifted and its file is not fingerprinted.
    expect(Object.keys(record.fingerprint.files)).toEqual([
      'app/Http/Controllers/CommentController.ts',
      'app/Http/Validators/CommentValidator.ts',
      'tests/comments.test.ts',
    ])
    expect(record.fingerprint.files['app/Http/Controllers/CommentController.ts']).toBe(sha256(APP['app/Http/Controllers/CommentController.ts']!))
    expect(result.verification).toEqual({ stateFile: '.guren/plans/http.state.json', staleSteps: [] })
    expect(result.skipped).toEqual([])

    const state = JSON.parse(await readFile(join(app, '.guren/plans/http.state.json'), 'utf8')) as { stateVersion: number; steps: Record<string, PlanStepRecord> }
    expect(state.stateVersion).toBe(PLAN_STATE_VERSION)
    expect(state.steps[HTTP]).toMatchObject({ outcome: 'incomplete', planDigest: planDigest(parsePlanDocument(loadCommentsPlan())) })
    expect(await readFile(join(app, '.guren/plans/.gitignore'), 'utf8')).toBe(PLAN_STATE_GITIGNORE)
    expect(Object.values(states(result))).not.toContain('verified')
  })

  test('should lay a recorded verification over plan:status, and turn it drifted when a fingerprinted file changes', async () => {
    const app = await createApp('lift')
    const plan = await writePlan('lift.plan.json')
    const record: PlanStepRecord = {
      outcome: 'verified',
      planDigest: planDigest(parsePlanDocument(loadCommentsPlan())),
      ranAt: '2026-09-21T00:00:00.000Z',
      durationMs: 1,
      commands: [],
      acceptance: [],
      incomplete: [],
      fingerprint: { files: { 'db/schema.ts': sha256(SCHEMA), 'app/Models/Comment.ts': sha256(APP['app/Models/Comment.ts']!) }, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'h' } },
    }
    await mkdir(join(app, '.guren/plans'), { recursive: true })
    await writeFile(join(app, '.guren/plans/lift.state.json'), JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: { [DATA]: record } }), 'utf8')

    const before = await status(plan, app)
    await writeFile(join(app, 'db/schema.ts'), `${SCHEMA}\n// touched\n`, 'utf8')
    const after = await status(plan, app)

    // `body` and `postId` differ from the plan on their own, and a record lifts nothing over a static verdict.
    expect(states(before)).toMatchObject({ 'column.comment.id': 'verified', 'column.comment.createdAt': 'verified', 'column.comment.body': 'drifted', 'column.comment.postId': 'drifted', 'model.comment': 'drifted' })
    expect(before.summary.states.verified).toBe(2)
    expect(states(after)).toMatchObject({ 'column.comment.id': 'drifted', 'column.comment.createdAt': 'drifted' })
    expect(after.elements.find((element) => element.id === 'column.comment.id')!.notes).toEqual([`Verified 2026-09-21T00:00:00.000Z by ${DATA}; changed since: db/schema.ts.`])
    expect(after.summary.states.verified).toBe(0)

    // A whole-plan run leaves a step alone while its record stands, and redoes it once a fingerprinted file changed.
    await writeFile(join(app, '.guren/plans/lift.state.json'), JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: { [DATA]: { ...record, fingerprint: { ...record.fingerprint, files: { 'db/schema.ts': sha256(`${SCHEMA}\n// touched\n`) } } } } }), 'utf8')
    const whole = await verify(plan, app)
    expect(whole.skipped).toEqual([DATA])
    expect(whole.steps.map((step) => step.stepId)).toEqual(['task/entity/model.comment/scaffold', 'task/entity/model.comment/tests', HTTP, 'task/entity/model.comment/pages'])
    await writeFile(join(app, 'db/schema.ts'), `${SCHEMA}\n// touched twice\n`, 'utf8')
    const redone = await verify(plan, app)
    // The pages step verified in the run before and still stands, and the scaffold step, which fingerprints nothing, stands on its commands.
    expect(redone.skipped).toEqual(['task/entity/model.comment/scaffold', 'task/entity/model.comment/pages'])
    expect(redone.steps.map((step) => step.stepId)).toContain(DATA)

    const revised = await writePlan('lift-revised.plan.json', { ...loadCommentsPlan(), title: 'Revised' })
    await writeFile(join(app, '.guren/plans/lift-revised.state.json'), JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: { [DATA]: record } }), 'utf8')
    const stale = await status(revised, app)
    expect(stale.verification).toEqual({ stateFile: '.guren/plans/lift-revised.state.json', staleSteps: [DATA] })
    expect(stale.summary.states.verified).toBe(0)
  })

  test('should judge the status after codegen on a fresh clone, whose controllers import the generated files', async () => {
    const { '.guren/routes.gen.ts': _routes, '.guren/pages.gen.ts': _pages, '.guren/data.gen.ts': _data, ...withoutGenerated } = APP
    const app = await createApp('fresh', {
      ...withoutGenerated,
      'package.json': JSON.stringify({
        name: 'verify-app',
        type: 'module',
        scripts: {
          codegen: "mkdir -p .guren && for f in routes pages data; do printf 'export {}\\n' > .guren/$f.gen.ts; done",
          typecheck: 'exit 0',
          'db:migrate': 'exit 0',
        },
      }),
      'app/Http/Controllers/CommentController.ts': `import { Controller } from '@guren/core'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'
import '../../../.guren/pages.gen.js'

export class CommentController extends Controller {
  async store() {
    await this.validateBody(CommentPayloadSchema)
    return this.redirect('/posts')
  }
}
`,
    })
    const plan = await writePlan('fresh.plan.json')

    const result = await verify(plan, app, '--step', HTTP)

    expect(result.steps[0]!.record.commands.map((command) => [command.command, command.status])).toEqual([['codegen', 'pass'], ['check', 'pass'], ['tests', 'pass']])
    expect(states(result)).toMatchObject({ 'action.comments.store': 'wired', 'route.comments.store': 'drifted', 'validator.comment': 'wired' })
  })

  test('should say when it replaced a state file it could not read', async () => {
    const app = await createApp('corrupt')
    const plan = await writePlan('corrupt.plan.json')
    await mkdir(join(app, '.guren/plans'), { recursive: true })
    await writeFile(join(app, '.guren/plans/corrupt.state.json'), '{', 'utf8')

    const result = await verify(plan, app, '--step', HTTP)

    expect(result.verification.unreadable).toMatch(/is not valid JSON.*; this run replaced it, and its other records are gone$/s)
    expect(Object.keys(JSON.parse(await readFile(join(app, '.guren/plans/corrupt.state.json'), 'utf8')).steps)).toEqual([HTTP])
  })

  test('should refuse a step the plan does not derive, naming the ones it does', async () => {
    const app = await createApp('unknown-step')
    const plan = await writePlan('unknown-step.plan.json')

    await expect(verify(plan, app, '--step', 'task/nope')).rejects.toThrow(/No step "task\/nope" is derived from this plan\. The steps are:\n(.|\n)*task\/entity\/model\.comment\/http/)
    await expect(verify(plan, app, '--timeout', 'soon')).rejects.toThrow('--timeout takes a positive number of seconds')
  })

  test('should exit 1 under --ci when a step did not verify, and print the steps before the status', async () => {
    const app = await createApp('ci')
    const plan = await writePlan('ci.plan.json')

    const output = await run('plan:verify', plan, app, '--step', HTTP, '--ci')

    expect(process.exitCode).toBe(1)
    expect(output).toMatch(new RegExp(`^${HTTP}: incomplete \\(\\d+ ms\\)\n  pass     codegen     bun run codegen\n  pass     check       guren check\n`))
    expect(output).toContain('  passing  [AC-comments-1]')
    expect(output).toContain('  not at its completion state: action.comments.destroy: planned')
    expect(output).toContain('Recorded in .guren/plans/ci.state.json')
    expect(output).toContain('Elements the plan changes:')
  })
})
