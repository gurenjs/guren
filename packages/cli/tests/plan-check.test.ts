import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand } from 'citty'
import { consola } from 'consola'

import { ciSuiteConflict, runCheck } from '../src/check'
import { gatingResults, type CheckResult } from '../src/check-result'
import { builtinSubCommands } from '../src/commands'
import { checkPlans, discoverPlanFiles, isPlanInput } from '../src/plan-check'
import { planApprovalsPath } from '../src/plan/approvals'
import { planDocClosedHash, renderPlanDoc } from '../src/plan/close-docs'
import { planHash } from '../src/plan/identity'
import { PlanSchema } from '../src/plan/schema'
import { PLAN_STATE_VERSION, planDigest, type PlanStepRecord } from '../src/plan/state'
import { derivePlanTasks } from '../src/plan/tasks'
import { writeWorkspaceFiles } from './helpers'
import { loadApprovedCommentsPlan, loadCommentsPlan, writePlanVerifyApp } from './plan-fixture'

// `bun test` fires no exit handler, so the roots earlier runs left are removed at the start.
// Each application has a directory of its own: Bun keys an imported routes file on its path.
const ROOT_PREFIX = 'guren-plan-check-'
let ROOT: string

const APPROVED_AT = '2026-09-22T09:00:00.000Z'

type PlanDocument = Record<string, unknown>
type Section = Array<Record<string, unknown>>

function planDocument(title: string, sections: { models?: Section; controllers?: Section; routes?: Section } = {}): PlanDocument {
  return {
    planVersion: 1,
    title,
    summary: `${title}.`,
    locale: 'en',
    scope: { goals: [title], nonGoals: [] },
    baseline: { rev: '6445bc71', contextHash: {} },
    ...sections,
  }
}

function model(id: string, kind: string, name: string, table: string, extra: { columns?: Section; module?: string; tableRenamedFrom?: string; from?: string } = {}): Record<string, unknown> {
  const { from, ...rest } = extra
  return { id, change: from ? { kind, from } : kind === 'drop' ? { kind, reason: 'Retired.' } : { kind }, name, table, columns: [], relationships: [], fillable: [], ...rest }
}

function column(id: string, kind: string, name: string): Record<string, unknown> {
  return { id, name, change: { kind }, type: 'string', nullable: false, unique: false, index: false }
}

/** A second plan altering `posts` under another id and class name than the comments plan's `model.post`. */
function statusPlan(options: { table?: string; name?: string; column?: string; id?: string } = {}): PlanDocument {
  const name = options.name ?? 'Entry'
  return planDocument(`${name} status`, { models: [model(options.id ?? `model.${name.toLowerCase()}`, 'alter', name, options.table ?? 'posts', { columns: [column(`column.${name.toLowerCase()}.${options.column ?? 'status'}`, 'add', options.column ?? 'status')] })] })
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

/** An app with no plan beside the given approved ones, each written under `docs/plans/<slug>/plan.json`. */
async function createAppWithPlans(name: string, plans: Record<string, PlanDocument>): Promise<string> {
  const dir = await createApp(name)
  await rm(join(dir, 'comments.plan.json'))
  for (const [slug, document] of Object.entries(plans)) {
    await writeWorkspaceFiles(dir, { [`docs/plans/${slug}/.keep`]: '' })
    await writePlan(join(dir, `docs/plans/${slug}/plan.json`), document)
  }
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

/** The doc node plan:close writes for the comments plan, closed at `hash`. */
function closeDoc(hash: string): string {
  const plan = PlanSchema.parse(loadApprovedCommentsPlan())
  return renderPlanDoc({ plan, hash, slug: 'comments', approval: { hash, approvedAt: APPROVED_AT }, elements: [], waived: new Map() })
}

const planResults = (checks: CheckResult[]): CheckResult[] => checks.filter((result) => result.key.startsWith('plan:'))
const byKey = (checks: CheckResult[], prefix: string): CheckResult[] => checks.filter((result) => result.key.startsWith(prefix))
const overlapMessage = async (dir: string): Promise<string> =>
  byKey(await checkPlans({ cwd: dir }), 'plan:overlap:')
    .map((result) => result.message)
    .join('\n')

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

  describe('discovery', () => {
    test('should contribute nothing in an app with no plan file', async () => {
      const dir = await createApp('none')
      await rm(join(dir, 'comments.plan.json'))

      expect(await discoverPlanFiles(dir)).toEqual({ files: [], unreadable: [] })
      expect(await checkPlans({ cwd: dir })).toEqual([])
    })

    test('should find the §9 layout and <slug>.plan.json, never the records beside them or a revision', async () => {
      const dir = await createApp('discovery')
      await writeWorkspaceFiles(dir, {
        'plan.json': '{}',
        'docs/plans/status/plan.json': '{}',
        'docs/plans/status/approvals.json': '{}',
        'docs/plans/status/revisions/1.plan.json': '{}',
        'docs/plans/tags.plan.json': '{}',
        'docs/plans/tags.approvals.json': '{}',
        'docs/plans/comments.md': '# closed',
        'notes.json': '{}',
      })

      const { files } = await discoverPlanFiles(dir)
      expect(files.map((path) => path.slice(dir.length + 1))).toEqual(['comments.plan.json', 'docs/plans/status/plan.json', 'docs/plans/tags.plan.json'])
    })

    test('should report a docs/plans directory that will not list, rather than throw', async () => {
      const dir = await createApp('eacces')
      await writeWorkspaceFiles(dir, { 'docs/plans/tags.plan.json': '{}' })
      await chmod(join(dir, 'docs/plans'), 0o000)
      try {
        const results = await checkPlans({ cwd: dir })
        const unreadable = byKey(results, 'plan:unreadable:docs/plans')
        expect(unreadable).toHaveLength(1)
        expect(unreadable[0]).toMatchObject({ status: 'warn', advisory: true })
        expect(unreadable[0].message).not.toContain(dir)
      } finally {
        await chmod(join(dir, 'docs/plans'), 0o755)
      }
    })

    test('should treat a plan, its records and anything under docs/plans as a --changed input', () => {
      for (const file of ['comments.plan.json', 'comments.approvals.json', 'comments.decisions.json', 'docs/plans/x/decisions.json', 'docs/plans/x/approvals.json', 'docs/plans/comments.md']) {
        expect(isPlanInput(file)).toBe(true)
      }
      for (const file of ['notes.json', 'app/Models/Post.ts', 'docs/entities/Post.md']) expect(isPlanInput(file)).toBe(false)
    })

    test('should report two plans that share a slug', async () => {
      const dir = await createApp('slug')
      await writeWorkspaceFiles(dir, { 'docs/plans/comments/plan.json': JSON.stringify(loadCommentsPlan()) })

      const shared = byKey(await checkPlans({ cwd: dir }), 'plan:slug:')

      expect(shared).toHaveLength(1)
      expect(shared[0]).toMatchObject({ key: 'plan:slug:comments', status: 'warn', advisory: true })
      expect(shared[0].message).toContain('comments.plan.json, docs/plans/comments/plan.json')
    })
  })

  describe('which plans are judged', () => {
    test('should judge a draft by neither rule, even beside an approvals file', async () => {
      const dir = await createApp('draft')
      const draft = loadCommentsPlan()
      const hash = planHash(PlanSchema.parse(loadApprovedCommentsPlan()))
      await writeFile(planApprovalsPath(join(dir, 'comments.plan.json')), JSON.stringify({ approvalsVersion: 1, approvals: [{ hash, approvedAt: APPROVED_AT }] }), 'utf8')
      await writeFile(join(dir, 'comments.plan.json'), JSON.stringify(draft), 'utf8')

      expect(await checkPlans({ cwd: dir })).toEqual([])
    })

    test('should judge a plan changed since its approval by neither rule', async () => {
      const dir = await createApp('unapproved')
      const document = loadApprovedCommentsPlan()
      await writePlan(join(dir, 'comments.plan.json'), document)
      await writeFile(join(dir, 'comments.plan.json'), JSON.stringify({ ...document, title: 'Comments, revised' }), 'utf8')

      expect(await checkPlans({ cwd: dir })).toEqual([])
    })

    test('should read back the hash from the doc node plan:close writes', () => {
      expect(planDocClosedHash(closeDoc('abc123'))).toBe('abc123')
      expect(planDocClosedHash('---\ntype: plan\nplan_hash: abc123\n---\n')).toBeUndefined()
    })

    test('should ignore a plan closed at its current hash, and judge it again once revised past the close', async () => {
      const dir = await createDriftedApp('closed')
      const hash = planHash(PlanSchema.parse(loadApprovedCommentsPlan()))

      await writeWorkspaceFiles(dir, { 'docs/plans/comments.md': closeDoc(hash) })
      expect(await checkPlans({ cwd: dir })).toEqual([])

      await writeWorkspaceFiles(dir, { 'docs/plans/comments.md': closeDoc('another-hash') })
      expect(byKey(await checkPlans({ cwd: dir }), 'plan:drifted:')).toHaveLength(1)
    })

    test('should report a plan or an approvals file that will not read, by app-relative path', async () => {
      const dir = await createApp('unreadable')
      await writeWorkspaceFiles(dir, {
        'docs/plans/broken.plan.json': '{',
        'docs/plans/tags.plan.json': JSON.stringify(statusPlan()),
        'docs/plans/tags.approvals.json': '{"approvalsVersion": 2}',
      })

      const unreadable = byKey(await checkPlans({ cwd: dir }), 'plan:unreadable:')

      expect(unreadable.map((result) => result.filePath)).toEqual(['docs/plans/broken.plan.json', 'docs/plans/tags.plan.json'])
      expect(unreadable.every((result) => result.status === 'warn' && result.advisory === true)).toBe(true)
      expect(unreadable[0].message).toContain('docs/plans/broken.plan.json is not valid JSON')
      expect(unreadable[1].message).toContain('docs/plans/tags.approvals.json does not match the approvals schema')
      expect(unreadable.map((result) => result.message).join('\n')).not.toContain(dir)
    })
  })

  describe('drift', () => {
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

    test('should exit 0 from check --plan with a drifted plan, and print only plan results', async () => {
      const dir = await createDriftedApp('command')
      log.mockImplementation(() => {})

      await runCommand(builtinSubCommands.check, { rawArgs: ['--plan', '--app', dir, '--json'] })

      const report = JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as { checks: CheckResult[] }
      expect(byKey(report.checks, 'plan:drifted:')).toHaveLength(1)
      expect(report.checks.every((result) => result.key.startsWith('plan:'))).toBe(true)
      expect(process.exitCode ?? 0).toBe(0)
    })

    test('should stay out of plain check, whose other suites never import the schema', async () => {
      const dir = await createDriftedApp('plain')

      expect(planResults((await runCheck({ cwd: dir })).checks)).toEqual([])
      expect(byKey((await runCheck({ cwd: dir, plan: true })).checks, 'plan:drifted:')).toHaveLength(1)
    })
  })

  describe('check --ci', () => {
    test('should not list --plan among the suites that gate on their own', () => {
      const message = ciSuiteConflict(['arch'])

      expect(message).toContain('--arch/--docs/--spec/--i18n/--prototype/--env (they gate on their own)')
      expect(message).not.toContain('--plan')
    })

    test('should name only --plan when --plan is the only suite flag given', () => {
      expect(ciSuiteConflict(['plan'])).toBe('--plan is advisory and never part of check --ci; run guren check --plan on its own.')
      expect(ciSuiteConflict(['plan', 'docs'])).toContain('(they gate on their own). --plan is advisory')
    })

    test('should refuse --ci --plan, saying --plan is advisory and runs on its own', async () => {
      const error = spyOn(consola, 'error').mockImplementation(Object.assign(() => {}, { raw: () => {} }))
      try {
        await runCommand(builtinSubCommands.check, { rawArgs: ['--ci', '--plan', '--app', ROOT] })

        const message = error.mock.calls.map((call) => String(call[0])).join('\n')
        expect(message).toContain('--plan is advisory and never part of check --ci')
        expect(message).not.toContain('they gate on their own')
        expect(process.exitCode).toBe(1)
      } finally {
        error.mockRestore()
      }
    })
  })

  describe('overlap', () => {
    test('should report two plans altering one model class under different ids, and not its table', async () => {
      const dir = await createApp('overlap')
      await writePlan(join(dir, 'comments.plan.json'), loadApprovedCommentsPlan())
      await writeWorkspaceFiles(dir, { 'docs/plans/status/.keep': '' })
      await writePlan(join(dir, 'docs/plans/status/plan.json'), statusPlan({ name: 'Post', id: 'model.article' }))

      const overlap = byKey(await checkPlans({ cwd: dir }), 'plan:overlap:')

      expect(overlap).toHaveLength(1)
      expect(overlap[0]).toMatchObject({ status: 'warn', advisory: true })
      expect(overlap[0].message).toContain('comments.plan.json and docs/plans/status/plan.json')
      expect(overlap[0].message).toContain('model class Post (model.post / model.article)')
      expect(overlap[0].message).not.toContain('table posts')
    })

    test('should not report two plans altering one table under different classes when their columns differ', async () => {
      const dir = await createApp('alter-apart')
      await writePlan(join(dir, 'comments.plan.json'), loadApprovedCommentsPlan())
      await writeWorkspaceFiles(dir, { 'docs/plans/status/.keep': '' })
      await writePlan(join(dir, 'docs/plans/status/plan.json'), statusPlan())

      expect(await overlapMessage(dir)).toBe('')
    })

    test('should not report two plans adding different columns under one existing model', async () => {
      const add = (column_: string) => planDocument(`Add ${column_}`, { models: [model('model.post', 'existing', 'Post', 'posts', { columns: [column(`column.post.${column_}`, 'add', column_)] })] })
      const dir = await createAppWithPlans('existing-apart', { status: add('status'), priority: add('priority') })

      expect(await overlapMessage(dir)).toBe('')
    })

    test('should not report a class rename against a column added under that class, since the table stays', async () => {
      const dir = await createAppWithPlans('class-rename', {
        rename: planDocument('Rename Post', { models: [model('model.post', 'rename', 'Article', 'posts', { from: 'Post' })] }),
        status: planDocument('Status', { models: [model('model.post', 'existing', 'Post', 'posts', { columns: [column('column.post.status', 'add', 'status')] })] }),
      })

      expect(await overlapMessage(dir)).toBe('')
    })

    test('should not report two plans adding a column of one name to different tables', async () => {
      const dir = await createAppWithPlans('apart', { status: statusPlan(), roles: statusPlan({ table: 'users', name: 'Member' }) })

      expect(await checkPlans({ cwd: dir })).toEqual([])
    })

    test('should not report an overlap with a plan that is only a draft', async () => {
      const dir = await createApp('draft-overlap')
      await writePlan(join(dir, 'comments.plan.json'), loadApprovedCommentsPlan())
      await writeWorkspaceFiles(dir, { 'docs/plans/status/.keep': '' })
      const { baseline: _baseline, ...draft } = statusPlan()
      await writePlan(join(dir, 'docs/plans/status/plan.json'), draft, false)

      expect(await overlapMessage(dir)).toBe('')
    })

    test('should report a table rename against a plan on either of its names', async () => {
      const rename = planDocument('Rename posts', { models: [model('model.post', 'existing', 'Post', 'articles', { tableRenamedFrom: 'posts' })] })
      const dir = await createAppWithPlans('rename', {
        rename,
        old: statusPlan({ table: 'posts', name: 'Old' }),
        new: statusPlan({ table: 'articles', name: 'New' }),
      })

      const message = await overlapMessage(dir)

      expect(message).toContain('docs/plans/new/plan.json and docs/plans/rename/plan.json')
      expect(message).toContain('docs/plans/old/plan.json and docs/plans/rename/plan.json')
      expect(message).toContain('table articles (model.new, column.new.status / model.post)')
      expect(message).toContain('table posts (model.old, column.old.status / model.post)')
    })

    test('should report a column added under a table another plan drops, and not under one it only alters', async () => {
      const addStatus = planDocument('Status', { models: [model('model.post', 'existing', 'Post', 'posts', { columns: [column('column.post.status', 'add', 'status')] })] })
      const dropped = createAppWithPlans('parent-drop', { status: addStatus, drop: planDocument('Drop posts', { models: [model('model.post', 'drop', 'Post', 'posts')] }) })
      const altered = createAppWithPlans('parent-alter', { status: addStatus, alter: statusPlan({ column: 'priority' }) })

      expect(await overlapMessage(await dropped)).toContain('table posts (model.post / column.post.status)')
      expect(await overlapMessage(await altered)).toBe('')
    })

    test('should report an action added under a controller another plan drops', async () => {
      const controller = (kind: string, actions: Section) => ({ id: 'controller.posts', change: kind === 'drop' ? { kind, reason: 'Retired.' } : { kind }, className: 'PostController', actions })
      const action = { id: 'action.posts.archive', change: { kind: 'add' }, name: 'archive', authorization: { middleware: ['auth'] }, response: { kind: 'redirect', to: '/posts' }, rules: [] }
      const dir = await createAppWithPlans('action-parent', {
        archive: planDocument('Archive', { controllers: [controller('existing', [action])] }),
        drop: planDocument('Drop', { controllers: [controller('drop', [])] }),
      })

      expect(await overlapMessage(dir)).toContain('controller class PostController (action.posts.archive / controller.posts)')
    })

    test('should report two routes on one endpoint under different names', async () => {
      const route = (id: string, name: string) => ({ id, change: { kind: 'add' }, method: 'GET', path: '/feed', name, action: 'action.feed', middleware: [], bind: [] })
      const dir = await createAppWithPlans('endpoint', {
        feed: planDocument('Feed', { routes: [route('route.feed', 'feed.index')] }),
        stream: planDocument('Stream', { routes: [route('route.stream', 'stream.index')] }),
      })

      expect(await overlapMessage(dir)).toContain('endpoint GET /feed (route.feed / route.stream)')
    })

    test('should key a class by its module and a table app-wide', async () => {
      const invoices = (module: string) => planDocument(`Invoices in ${module}`, { models: [model(`model.${module}.invoice`, 'add', 'Invoice', 'invoices', { module })] })
      const dir = await createAppWithPlans('modules', { billing: invoices('billing'), shop: invoices('shop') })

      const message = await overlapMessage(dir)

      expect(message).toContain('table invoices (model.billing.invoice / model.shop.invoice)')
      expect(message).not.toContain('model class Invoice')
    })
  })
})
