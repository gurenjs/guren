import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { runCheck } from '../src/check'
import { gatingResults, type CheckResult } from '../src/check-result'
import { builtinSubCommands } from '../src/commands'
import { checkPlans, discoverPlanFiles } from '../src/plan-check'
import { planApprovalsPath } from '../src/plan/approvals'
import { planHash } from '../src/plan/identity'
import { PlanSchema } from '../src/plan/schema'
import { PLAN_STATE_VERSION, planDigest, type PlanStepRecord } from '../src/plan/state'
import { derivePlanTasks } from '../src/plan/tasks'
import { writeWorkspaceFiles } from './helpers'
import { loadApprovedCommentsPlan, writePlanVerifyApp } from './plan-fixture'

// `bun test` fires no exit handler, so the roots earlier runs left are removed at the start.
// Each application has a directory of its own: Bun keys an imported routes file on its path.
const ROOT_PREFIX = 'guren-plan-check-'
let ROOT: string

const APPROVED_AT = '2026-09-22T09:00:00.000Z'

type PlanDocument = Record<string, unknown>

/** A second plan altering `posts` under another id and class name than the comments plan's `model.post`. */
function statusPlan(options: { table?: string; column?: string; name?: string } = {}): PlanDocument {
  return {
    planVersion: 1,
    title: 'Post status',
    summary: 'Posts carry a status.',
    locale: 'en',
    scope: { goals: ['Mark a post as draft'], nonGoals: [] },
    baseline: { rev: '6445bc71', contextHash: {} },
    models: [
      {
        id: `model.${(options.name ?? 'Entry').toLowerCase()}`,
        change: { kind: 'alter' },
        name: options.name ?? 'Entry',
        table: options.table ?? 'posts',
        columns: [{ id: 'column.entry.status', name: options.column ?? 'status', change: { kind: 'add' }, type: 'string', nullable: false, unique: false, index: false }],
        relationships: [],
        fillable: [],
      },
    ],
  }
}

async function writePlan(path: string, document: PlanDocument, approve = true): Promise<void> {
  await writeFile(path, JSON.stringify(document), 'utf8')
  if (!approve) return
  const hash = planHash(PlanSchema.parse(document))
  await writeFile(planApprovalsPath(path), JSON.stringify({ approvalsVersion: 1, approvals: [{ hash, approvedAt: APPROVED_AT }] }), 'utf8')
}

async function createApp(name: string): Promise<string> {
  const dir = join(ROOT, name)
  await writePlanVerifyApp(dir)
  return dir
}

/** The comments plan approved at the app root, with a verification record whose fingerprint does not match `app/Models/Comment.ts`. */
async function createDriftedApp(name: string): Promise<string> {
  const dir = await createApp(name)
  const document = loadApprovedCommentsPlan()
  await writePlan(join(dir, 'comments.plan.json'), document)
  const plan = PlanSchema.parse(document)
  const step = derivePlanTasks(plan, { apiOnly: false }).tasks.flatMap((task) => task.steps).find((entry) => entry.elementIds.includes('column.comment.id'))!
  const record: PlanStepRecord = {
    outcome: 'verified',
    planDigest: planDigest(plan),
    ranAt: '2026-09-22T11:00:00.000Z',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    waived: [],
    fingerprint: { files: { 'app/Models/Comment.ts': 'not-the-hash' }, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
  }
  await writeWorkspaceFiles(dir, { '.guren/plans/comments.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: { [step.id]: record } }) })
  return dir
}

const planResults = (checks: CheckResult[]): CheckResult[] => checks.filter((result) => result.key.startsWith('plan:'))
const byKey = (checks: CheckResult[], prefix: string): CheckResult[] => checks.filter((result) => result.key.startsWith(prefix))

describe('guren check --plan', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    const stale = (await readdir(tmpdir())).filter((entry) => entry.startsWith(ROOT_PREFIX))
    await Promise.all(stale.map((entry) => rm(join(tmpdir(), entry), { recursive: true, force: true })))
    ROOT = await mkdtemp(join(tmpdir(), ROOT_PREFIX))
  })

  afterEach(() => {
    log.mockReset()
    process.exitCode = 0
  })

  afterAll(() => {
    log.mockRestore()
  })

  test('should contribute nothing to plain check in an app with no plan file', async () => {
    const dir = await createApp('none')
    await rm(join(dir, 'comments.plan.json'))

    expect(await discoverPlanFiles(dir)).toEqual([])
    expect(await checkPlans({ cwd: dir })).toEqual([])
    expect(planResults((await runCheck({ cwd: dir })).checks)).toEqual([])
  })

  test('should find the §9 layout and <slug>.plan.json, never the records beside them or a revision', async () => {
    const dir = await createApp('discovery')
    await writeWorkspaceFiles(dir, {
      'docs/plans/status/plan.json': '{}',
      'docs/plans/status/approvals.json': '{}',
      'docs/plans/status/revisions/1.plan.json': '{}',
      'docs/plans/tags.plan.json': '{}',
      'docs/plans/tags.approvals.json': '{}',
      'docs/plans/comments.md': '# closed',
      'notes.json': '{}',
    })

    expect((await discoverPlanFiles(dir)).map((path) => path.slice(dir.length + 1))).toEqual(['comments.plan.json', 'docs/plans/status/plan.json', 'docs/plans/tags.plan.json'])
  })

  test('should judge a draft by neither rule', async () => {
    const dir = await createApp('draft')

    expect(await checkPlans({ cwd: dir })).toEqual([])
  })

  test('should report the drifted elements of an approved plan as an advisory warning', async () => {
    const dir = await createDriftedApp('drifted')

    const results = await checkPlans({ cwd: dir })
    const drifted = byKey(results, 'plan:drifted:')

    expect(drifted).toHaveLength(1)
    expect(drifted[0]).toMatchObject({ status: 'warn', advisory: true, filePath: 'comments.plan.json' })
    expect(drifted[0].message).toContain('column.comment.id')
    expect(gatingResults({ cwd: dir, checks: results, passCount: 0, warnCount: 0, failCount: 0 })).toEqual([])
  })

  test('should not name an element whose verification record is gone', async () => {
    const dir = await createDriftedApp('not-drifted')
    await rm(join(dir, '.guren/plans/comments.state.json'))

    // The fixture app differs from the plan elsewhere, which plan:status calls drifted too.
    const drifted = byKey(await checkPlans({ cwd: dir }), 'plan:drifted:')
    expect(drifted.map((result) => result.message).join('\n')).not.toContain('column.comment.id')
  })

  test('should exit 0 from check --plan with a drifted plan, and print it', async () => {
    const dir = await createDriftedApp('command')
    log.mockImplementation(() => {})

    await runCommand(builtinSubCommands.check, { rawArgs: ['--plan', '--app', dir, '--json'] })

    const report = JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as { checks: CheckResult[] }
    expect(byKey(report.checks, 'plan:drifted:')).toHaveLength(1)
    expect(report.checks.every((result) => result.key.startsWith('plan:'))).toBe(true)
    expect(process.exitCode ?? 0).toBe(0)
  })

  test('should keep plan findings out of the check --ci gate', async () => {
    const dir = await createDriftedApp('ci')

    const report = await runCheck({ cwd: dir })

    expect(byKey(report.checks, 'plan:drifted:')).toHaveLength(1)
    expect(planResults(gatingResults(report))).toEqual([])
  })

  test('should ignore a plan closed at its current hash, and judge it again once revised past the close', async () => {
    const dir = await createDriftedApp('closed')
    const hash = planHash(PlanSchema.parse(loadApprovedCommentsPlan()))
    const doc = (planHash: string): string => `---\ntype: plan\nentities: [Comment]\nclosed: true\nplan_hash: ${planHash}\n---\n\n# Comments on posts\n`

    await writeWorkspaceFiles(dir, { 'docs/plans/comments.md': doc(hash) })
    expect(await checkPlans({ cwd: dir })).toEqual([])

    await writeWorkspaceFiles(dir, { 'docs/plans/comments.md': doc('another-hash') })
    expect(byKey(await checkPlans({ cwd: dir }), 'plan:drifted:')).toHaveLength(1)
  })

  test('should judge a plan changed since its approval by neither rule', async () => {
    const dir = await createApp('unapproved')
    const document = loadApprovedCommentsPlan()
    await writePlan(join(dir, 'comments.plan.json'), document)
    await writeFile(join(dir, 'comments.plan.json'), JSON.stringify({ ...document, title: 'Comments, revised' }), 'utf8')

    expect(await checkPlans({ cwd: dir })).toEqual([])
  })

  test('should report two open plans changing one table under different ids', async () => {
    const dir = await createApp('overlap')
    await writePlan(join(dir, 'comments.plan.json'), loadApprovedCommentsPlan())
    await writeWorkspaceFiles(dir, { 'docs/plans/status/.keep': '' })
    await writePlan(join(dir, 'docs/plans/status/plan.json'), statusPlan())

    const overlap = byKey(await checkPlans({ cwd: dir }), 'plan:overlap:')

    expect(overlap).toHaveLength(1)
    expect(overlap[0]).toMatchObject({ status: 'warn', advisory: true })
    expect(overlap[0].message).toContain('comments.plan.json and docs/plans/status/plan.json')
    expect(overlap[0].message).toContain('table posts (model.post / model.entry)')
  })

  test('should not report two plans adding a column of one name to different tables', async () => {
    const dir = await createApp('apart')
    await writeWorkspaceFiles(dir, { 'docs/plans/status/.keep': '', 'docs/plans/roles/.keep': '' })
    await writePlan(join(dir, 'docs/plans/status/plan.json'), statusPlan())
    await writePlan(join(dir, 'docs/plans/roles/plan.json'), statusPlan({ table: 'users', name: 'Member' }))

    expect(await checkPlans({ cwd: dir })).toEqual([])
  })

  test('should not report an overlap with a plan that is only a draft', async () => {
    const dir = await createApp('draft-overlap')
    await writePlan(join(dir, 'comments.plan.json'), loadApprovedCommentsPlan())
    await writeWorkspaceFiles(dir, { 'docs/plans/status/.keep': '' })
    const { baseline: _baseline, ...draft } = statusPlan()
    await writePlan(join(dir, 'docs/plans/status/plan.json'), draft, false)

    expect(byKey(await checkPlans({ cwd: dir }), 'plan:overlap:')).toEqual([])
  })

  test('should report a plan or an approvals file that will not read, never skip it', async () => {
    const dir = await createApp('unreadable')
    await writeWorkspaceFiles(dir, {
      'docs/plans/broken.plan.json': '{',
      'docs/plans/tags.plan.json': JSON.stringify(statusPlan()),
      'docs/plans/tags.approvals.json': '{"approvalsVersion": 2}',
    })

    const results = await checkPlans({ cwd: dir })
    const unreadable = byKey(results, 'plan:unreadable:')

    expect(unreadable.map((result) => result.filePath)).toEqual(['docs/plans/broken.plan.json', 'docs/plans/tags.plan.json'])
    expect(unreadable.every((result) => result.status === 'warn' && result.advisory === true)).toBe(true)
    expect(unreadable[0].message).toContain('not valid JSON')
    expect(unreadable[1].message).toContain('approvals schema')
  })
})
