import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { planApproveFile } from '../src/plan-approve'
import type { PlanNextReport } from '../src/plan-next'
import { parsePlanDocument } from '../src/plan-render'
import type { PlanStatusReport } from '../src/plan-status'
import { formatPlanVerify, type PlanVerifyReport } from '../src/plan-verify'
import { planWaiveFile } from '../src/plan-waive'
import { loadPlanAppState } from '../src/plan/app-state'
import { planDigest, PLAN_STATE_GITIGNORE, PLAN_STATE_VERSION, type PlanStepRecord } from '../src/plan/state'
import { stampContextHash } from '../src/plan/freshness'
import { sha256 } from '../src/plan/verification'
import { createTempRoot, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'
import { approveIfStamped, approvePlanFile, loadApprovedCommentsPlan, loadCommentsPlan, PLAN_APP_FILES, planAppState, PLAN_VERIFY_APP_FILES as APP, PLAN_VERIFY_SCHEMA as SCHEMA } from './plan-fixture'

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

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Approver', '-c', 'user.email=approver@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

/** A plan with a baseline is approved at its hash unless `approve` is false, as `plan:approve` would leave it. */
async function writePlan(name: string, document: unknown = loadCommentsPlan(), { approve = true } = {}): Promise<string> {
  await writeWorkspaceFiles(ROOT, { [name]: JSON.stringify(document) })
  if (approve) await approveIfStamped(join(ROOT, name), document)
  return join(ROOT, name)
}

describe('plan:verify', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    ROOT = await createTempRoot(ROOT_PREFIX)
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
    expect(result.verification).toEqual({ stateFile: '.guren/plans/http.state.json', staleSteps: [], decisionsFile: '../http.decisions.json', staleWaivers: [] })
    expect(result.skipped).toEqual([])

    const state = JSON.parse(await readFile(join(app, '.guren/plans/http.state.json'), 'utf8')) as { stateVersion: number; steps: Record<string, PlanStepRecord> }
    expect(state.stateVersion).toBe(PLAN_STATE_VERSION)
    expect(state.steps[HTTP]).toMatchObject({ outcome: 'incomplete', planDigest: planDigest(parsePlanDocument(loadCommentsPlan())) })
    expect(await readFile(join(app, '.guren/plans/.gitignore'), 'utf8')).toBe(PLAN_STATE_GITIGNORE)
    expect(Object.values(states(result))).not.toContain('verified')
  })

  test('should report the stale context of the step it ran beside an outcome staleness does not change', async () => {
    // Approved while the app had Post; another commit has since renamed it.
    const app = await createApp('stale', { ...APP, 'app/Models/Post.ts': APP['app/Models/Post.ts']!.replace('class Post ', 'class Article ') })
    const baseline = { rev: 'abc123', contextHash: stampContextHash(parsePlanDocument(loadCommentsPlan()), planAppState()).contextHash }
    const plan = await writePlan('stale.plan.json', { ...loadCommentsPlan(), baseline })

    const result = await verify(plan, app, '--step', HTTP)

    expect(result.steps[0]!.record.outcome).toBe('incomplete')
    expect(result.freshness!.elements.find((element) => element.id === 'model.post')!.verdict).toBe('stale')
    expect(result.staleContext).toEqual([
      {
        stepId: HTTP,
        taskId: 'task/entity/model.comment',
        stale: [expect.objectContaining({ id: 'model.post', owned: false, through: ['route.comments.store'], within: [] })],
        // Validators are never read, so the one the step owns is unconfirmed and holds nothing.
        unconfirmed: [expect.objectContaining({ id: 'validator.comment', verdict: 'unjudged', owned: true })],
      },
    ])
    const text = formatPlanVerify(result)
    expect(text).toContain(`${HTTP}: depends on what changed since the plan was approved: model.post (named by route.comments.store); plan:next holds it until the plan is revised and approved`)
    expect(text).toContain('Against the approved baseline: fresh ')
  })

  test('should leave the marked step\u2019s own half-built elements out of its stale context', async () => {
    // The Comment class is written and its table is not: neither the stamp nor what the plan leaves.
    const app = await createApp('half-built', { ...APP, 'db/schema.ts': PLAN_APP_FILES['db/schema.ts']! })
    const active = { plan: 'half.plan.json', step: DATA, startedAt: '2026-09-21T09:00:00.000Z', continuations: 0 }
    await writeWorkspaceFiles(app, { '.guren/plans/half.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: {}, active }) })
    const baseline = { rev: 'abc123', contextHash: stampContextHash(parsePlanDocument(loadCommentsPlan()), planAppState()).contextHash }
    const plan = await writePlan('half.plan.json', { ...loadCommentsPlan(), baseline })

    const result = await verify(plan, app, '--step', DATA)

    expect(result.freshness!.elements.find((element) => element.id === 'model.comment')!.verdict).toBe('stale')
    expect(result.staleContext ?? []).toEqual([])
  })

  test('should refuse a plan whose hash no approval names before any command runs or anything is recorded, and verify once approved', async () => {
    const app = await createApp('unapproved')
    const plan = await writePlan('unapproved.plan.json', loadApprovedCommentsPlan(), { approve: false })

    await expect(verify(plan, app, '--step', HTTP)).rejects.toThrow(`${plan} is not approved at its current hash`)
    await expect(verify(plan, app)).rejects.toThrow('so no step is verified against it')
    // No state directory, which the first step's record would have created.
    await expect(readdir(join(app, '.guren/plans'))).rejects.toThrow('ENOENT')

    await approvePlanFile(plan)
    const result = await verify(plan, app, '--step', HTTP)
    expect(result.steps.map((step) => step.stepId)).toEqual([HTTP])
    expect(result.approval).toMatchObject({ state: 'approved', approval: { approvedBy: 'Ada <ada@example.com>' } })
  })

  test('should refuse while its approvals file will not read, whether or not the plan carries a baseline', async () => {
    const app = await createApp('unreadable-approvals')
    const plan = await writePlan('unreadable-approvals.plan.json', loadApprovedCommentsPlan(), { approve: false })
    await writeWorkspaceFiles(ROOT, { 'unreadable-approvals.approvals.json': '{ "approvalsVersion": 1 }\n' })

    await expect(verify(plan, app, '--step', HTTP)).rejects.toThrow('does not match the approvals schema')
    // A draft's unreadable approvals may hold the approval its deleted baseline had, so it refuses too.
    const draft = await writePlan('unreadable-approvals-draft.plan.json')
    await writeWorkspaceFiles(ROOT, { 'unreadable-approvals-draft.approvals.json': '{' })
    await expect(verify(draft, app, '--step', HTTP)).rejects.toThrow('is not valid JSON')
    await expect(readdir(join(app, '.guren/plans'))).rejects.toThrow('ENOENT')
  })

  test('should refuse an approved plan whose baseline was deleted, which would otherwise pass as a draft', async () => {
    const app = await createApp('baseline-removed')
    const plan = await writePlan('baseline-removed.plan.json', loadApprovedCommentsPlan())
    const { baseline: _baseline, ...draft } = loadApprovedCommentsPlan()
    await writePlan('baseline-removed.plan.json', draft)

    await expect(verify(plan, app, '--step', HTTP)).rejects.toThrow(`${plan} has lost its baseline, but 1 approval(s) are recorded beside it, so no step is verified against it`)
    await expect(readdir(join(app, '.guren/plans'))).rejects.toThrow('ENOENT')
  })

  test('should accept a plan plan:approve stamped and approved, in plan:next and plan:verify alike', async () => {
    // The application before the plan: approval refuses one that already declares what the plan adds.
    const app = await createApp('approved-for-real', { ...PLAN_APP_FILES, '.gitignore': 'node_modules\n' })
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')
    const plan = await writePlan('approved-for-real.plan.json', { ...loadCommentsPlan(), questions: [] })

    const approved = await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app })
    await runCommand(builtinSubCommands['plan:next'] as CommandDef, { rawArgs: [plan, '--app', app, '--json'] })
    const next = JSON.parse(String(log.mock.calls.at(-1)![0])) as PlanNextReport
    const result = await verify(plan, app, '--step', HTTP)

    expect(approved.stamped).toBeDefined()
    expect(next.plan.hash).toBe(approved.plan.hash)
    expect(next.step).not.toBeNull()
    expect(result.plan.hash).toBe(approved.plan.hash)
    expect(result.steps.map((step) => step.stepId)).toEqual([HTTP])
  })

  test('should verify a step whose only incomplete elements the decision log waives', async () => {
    const app = await createApp('waived')
    const plan = await writePlan('waived.plan.json', loadApprovedCommentsPlan())
    // What the app leaves the http step: four elements never written, and a store route that drifted.
    const unwritten = ['action.comments.destroy', 'route.comments.destroy', 'resource.comment', 'policy.comment', 'route.comments.store']
    await planWaiveFile(plan, {
      elementIds: unwritten,
      reason: 'delete lands in the next plan',
      now: () => new Date('2026-09-21T12:00:00.000Z'),
      exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    })

    const result = await verify(plan, app, '--step', HTTP)
    const { record } = result.steps[0]!

    expect(record.outcome).toBe('verified')
    expect(record.incomplete).toEqual([])
    expect(record.waived.sort()).toEqual([...unwritten].sort())
    // The report the same run prints lifts exactly what the record left out.
    expect(states(result)).toMatchObject(Object.fromEntries(unwritten.map((id) => [id, 'waived'])))
    expect(result.verification.decisionsFile).toBe('../waived.decisions.json')
  })

  test('should report a decision log it could not read once, having judged and lifted as if none were taken', async () => {
    const app = await createApp('unreadable-log')
    const plan = await writePlan('unreadable-log.plan.json', loadApprovedCommentsPlan())
    await writeWorkspaceFiles(ROOT, { 'unreadable-log.decisions.json': '{ "decisionsVersion": 2 }\n' })

    const result = await verify(plan, app, '--step', HTTP)

    expect(result.steps[0]!.record.outcome).toBe('incomplete')
    expect(result.steps[0]!.record.waived).toEqual([])
    expect(result.verification.decisionsUnreadable).toContain('does not match the decision log schema')
    expect(result.summary.states.waived).toBe(0)
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
      waived: [],
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
    expect(stale.verification).toEqual({ stateFile: '.guren/plans/lift-revised.state.json', staleSteps: [DATA], decisionsFile: '../lift-revised.decisions.json', staleWaivers: [] })
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
