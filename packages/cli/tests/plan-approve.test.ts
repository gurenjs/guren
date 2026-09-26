import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { chmod, lstat, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { planApproveFile, type PlanApproveReport } from '../src/plan-approve'
import { renderPlanFile } from '../src/plan-render'
import { formatPlanStatus, planStatusFile } from '../src/plan-status'
import { loadPlanAppState } from '../src/plan/app-state'
import { planApprovalsPath, readPlanApprovals } from '../src/plan/approvals'
import { writeFileAtomic } from '../src/plan/beside'
import { stampContextHash } from '../src/plan/freshness'
import { planHash } from '../src/plan/identity'
import { PlanDraftSchema, PlanSchema } from '../src/plan/schema'
import { runCaptured, type CapturedExec } from '../src/subprocess'
import { createTempRoot, writeWorkspaceFiles } from './helpers'
import { loadApprovedCommentsPlan, loadCommentsPlan, PLAN_APP_FILES, planAppState } from './plan-fixture'

const ROOT_PREFIX = 'guren-plan-approve-'
let ROOT: string
const NOW = () => new Date('2026-09-22T09:00:00.000Z')

beforeAll(async () => {
  ROOT = await createTempRoot(ROOT_PREFIX)
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Approver', '-c', 'user.email=approver@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/** The comments fixture with its one question answered, which is what approval needs. */
function answeredPlan(base: Record<string, unknown> = loadCommentsPlan()): Record<string, unknown> {
  return { ...base, questions: [] }
}

/** The on-disk app the command reads, a committed git repository unless `committed` is false, with the plan beside it. */
async function createApp(name: string, plan: Record<string, unknown>, options: { committed?: boolean; planFile?: string } = {}) {
  const app = join(ROOT, name)
  const planFile = options.planFile ?? 'comments.plan.json'
  await writeWorkspaceFiles(app, { ...PLAN_APP_FILES, [planFile]: JSON.stringify(plan) })
  if (options.committed !== false) {
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')
    git(app, 'config', 'user.name', 'Approver')
    git(app, 'config', 'user.email', 'approver@example.com')
  }
  return { app, plan: join(app, planFile) }
}

describe('planApprovalsPath', () => {
  test('should keep approvals beside the plan: approvals.json in the §9 layout, <slug>.approvals.json otherwise', () => {
    expect(planApprovalsPath('/repo/docs/plans/comments/plan.json')).toBe('/repo/docs/plans/comments/approvals.json')
    expect(planApprovalsPath('/repo/comments.plan.json')).toBe('/repo/comments.approvals.json')
    expect(planApprovalsPath('/repo/comments.json')).toBe('/repo/comments.approvals.json')
  })
})

describe('guren plan:approve', () => {
  let logged: string[]
  let log: ReturnType<typeof spyOn>
  beforeAll(() => {
    log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.join(' '))
    })
  })
  afterEach(() => {
    logged = []
  })
  afterAll(() => log.mockRestore())
  logged = []

  test('should stamp a draft once, write it back, and record the approval of its hash', async () => {
    const { app, plan } = await createApp('draft', answeredPlan())
    const head = git(app, 'rev-parse', 'HEAD')

    await runCommand(builtinSubCommands['plan:approve'], { rawArgs: [plan, '--app', app, '--json'] })
    const report = JSON.parse(logged.join('\n')) as PlanApproveReport

    const written = JSON.parse(await readFile(plan, 'utf8')) as Record<string, unknown>
    // What the command's own loader reads of the committed app, hashed the way the stamp is.
    const stamp = stampContextHash(PlanDraftSchema.parse(answeredPlan()), await loadPlanAppState(app))
    expect(written.baseline).toEqual({ rev: head, contextHash: stamp.contextHash })
    const contextHash = stamp.contextHash
    expect(Object.keys(contextHash)).toContain('model.post')
    // The author's document plus the baseline: nothing else is rewritten.
    expect({ ...written, baseline: undefined }).toEqual({ ...answeredPlan(), baseline: undefined })

    const hash = planHash(PlanSchema.parse(written))
    expect(report).toMatchObject({
      plan: { file: 'comments.plan.json', title: 'Comments on posts', hash },
      approvalsFile: 'comments.approvals.json',
      stamped: { rev: head, elements: Object.keys(contextHash).length },
      approval: { hash, approvedBy: 'Approver <approver@example.com>' },
      alreadyApproved: false,
    })
    // A validator is read by its exported schema symbol, so it is hashed like any other element.
    expect(Object.keys(contextHash)).toContain('validator.comment')
    expect(report.stamped!.unstamped).toEqual([])
    expect((await readPlanApprovals(plan)).value!.approvals).toEqual([report.approval])
  })

  test('should record a second approval of the same hash as nothing, touching neither file', async () => {
    const { app, plan } = await createApp('again', answeredPlan())
    const first = await planApproveFile(plan, { app: planAppState(), appRoot: app, now: NOW })
    const planBytes = await readFile(plan, 'utf8')
    const approvalBytes = await readFile(planApprovalsPath(plan), 'utf8')

    const second = await planApproveFile(plan, { app: planAppState(), appRoot: app, now: () => new Date('2026-09-23T00:00:00.000Z') })

    expect(second.alreadyApproved).toBe(true)
    expect(second.stamped).toBeUndefined()
    expect(second.approval).toEqual(first.approval)
    expect(await readFile(plan, 'utf8')).toBe(planBytes)
    expect(await readFile(planApprovalsPath(plan), 'utf8')).toBe(approvalBytes)
  })

  test('should never restamp a plan that carries a baseline, and approve the hash it already has', async () => {
    const document = answeredPlan(loadApprovedCommentsPlan())
    const { app, plan } = await createApp('baseline', document, { planFile: 'docs/plans/comments/plan.json' })
    const before = await readFile(plan, 'utf8')

    const report = await planApproveFile(plan, { app: planAppState(), appRoot: app, now: NOW })

    expect(await readFile(plan, 'utf8')).toBe(before)
    expect(report.stamped).toBeUndefined()
    expect(report.plan.hash).toBe(planHash(PlanSchema.parse(document)))
    expect(report.approvalsFile).toBe('docs/plans/comments/approvals.json')
  })

  test('should refuse while a question is open, writing nothing', async () => {
    const { app, plan } = await createApp('question', loadCommentsPlan())
    const before = await readFile(plan, 'utf8')

    await expect(planApproveFile(plan, { app: planAppState(), appRoot: app })).rejects.toThrow(/question Q-delete is unanswered: Does deleting a comment remove the row\?/)
    expect(await readFile(plan, 'utf8')).toBe(before)
    expect((await readPlanApprovals(plan)).value).toBeUndefined()
  })

  test('should refuse while a reference check fails, naming the element', async () => {
    const document = answeredPlan()
    ;(document.models as Array<Record<string, unknown>>)[0]!.name = 'Article'
    const { app, plan } = await createApp('failing', document)

    await expect(runCommand(builtinSubCommands['plan:approve'], { rawArgs: [plan, '--app', app] })).rejects.toThrow(/model\.post: The model class "Article" was not found/)
    expect((await readPlanApprovals(plan)).value).toBeUndefined()
  })

  test('should refuse to invent a rev outside a git repository', async () => {
    const { app, plan } = await createApp('no-git', answeredPlan(), { committed: false })
    const before = await readFile(plan, 'utf8')

    await expect(planApproveFile(plan, { app: planAppState(), appRoot: app })).rejects.toThrow(/has no commit git can name .*commit the application first/s)
    expect(await readFile(plan, 'utf8')).toBe(before)
  })

  test('should refuse while a section cannot be read, unless told to approve without it', async () => {
    const { app, plan } = await createApp('unstamped', answeredPlan())
    const before = await readFile(plan, 'utf8')
    const unread = planAppState({ tables: { unreadable: 'db/schema.ts declared no table this parser could read' } })

    await expect(planApproveFile(plan, { app: unread, appRoot: app })).rejects.toThrow(
      /The application's tables could not be read, so these elements would get no context hash[\s\S]*  model\.post: [\s\S]*--allow-unstamped/,
    )
    expect(await readFile(plan, 'utf8')).toBe(before)

    const report = await planApproveFile(plan, { app: unread, appRoot: app, allowUnstamped: true, now: NOW })
    const unstamped = report.stamped!.unstamped.map((entry) => entry.id)
    expect(unstamped).toEqual(expect.arrayContaining(['model.post', 'column.post.id']))
    expect(unstamped).not.toContain('validator.comment')
  })

  test('should refuse while the validators cannot be read, as for any other section', async () => {
    const { app, plan } = await createApp('unstamped-validators', answeredPlan())
    const unread = planAppState({ validators: { unreadable: 'app/Http/Validators/PostValidator.ts could not be read for its exported schemas' } })

    await expect(planApproveFile(plan, { app: unread, appRoot: app })).rejects.toThrow(
      /The application's validators could not be read[\s\S]*  validator\.comment: [\s\S]*PostValidator\.ts[\s\S]*--allow-unstamped/,
    )
  })

  test('should take --allow-unstamped on the command line', async () => {
    const document = answeredPlan()
    const { app, plan } = await createApp('unstamped-flag', document)
    // A module whose schema holds only a comment, as make:module leaves it, makes every table unreadable.
    await writeWorkspaceFiles(app, { 'modules/billing/index.ts': 'export default {}\n', 'modules/billing/db/schema.ts': '// tables go here\n' })
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'module')

    await expect(runCommand(builtinSubCommands['plan:approve'], { rawArgs: [plan, '--app', app] })).rejects.toThrow(/--allow-unstamped/)
    await runCommand(builtinSubCommands['plan:approve'], { rawArgs: [plan, '--app', app, '--allow-unstamped'] })
    expect((await readPlanApprovals(plan)).value!.approvals).toHaveLength(1)
  })

  test('should refuse to stamp a dirty tree, the plan and its own records excepted', async () => {
    const { app, plan } = await createApp('dirty', answeredPlan())
    // The plan's own edits, and an earlier run's state, are what approving is about.
    await writeFile(plan, JSON.stringify(answeredPlan(), null, 1), 'utf8')
    await writeWorkspaceFiles(app, { '.guren/plans/comments.state.json': '{}' })
    await writeFile(join(app, 'app/Models/Tag.ts'), 'export class Tag {}\n', 'utf8')

    await expect(planApproveFile(plan, { app: planAppState(), appRoot: app })).rejects.toThrow(/uncommitted changes[\s\S]*Commit or discard them first:\n {2}\?\? app\/Models\/Tag\.ts$/)

    await rm(join(app, 'app/Models/Tag.ts'))
    const report = await planApproveFile(plan, { app: planAppState(), appRoot: app, now: NOW })
    expect(report.stamped).toBeDefined()
  })

  test('should approve a brand-new plan directory, its rendered page beside it, without calling the tree dirty', async () => {
    const { app } = await createApp('new-dir', answeredPlan())
    const plan = join(app, 'docs/plans/comments/plan.json')
    await writeWorkspaceFiles(app, { 'docs/plans/comments/plan.json': JSON.stringify(answeredPlan()), 'docs/plans/comments/plan.html': '<html></html>\n' })
    await writeFile(join(app, 'docs/plans/comments/.plan.json.1.2.tmp'), 'left over', 'utf8')

    const report = await planApproveFile(plan, { app: planAppState(), appRoot: app, now: NOW })
    expect(report.stamped).toBeDefined()
    expect(report.approvalsFile).toBe('docs/plans/comments/approvals.json')

    // Anything else in that new directory is still a change.
    await writeFile(join(app, 'docs/plans/comments/notes.md'), 'x\n', 'utf8')
    await writeFile(plan, JSON.stringify(answeredPlan()), 'utf8')
    await expect(planApproveFile(plan, { app: planAppState(), appRoot: app })).rejects.toThrow(/\?\? docs\/plans\/comments\/notes\.md$/)
  })

  test('should exclude its own plan when the application root is reached through a symlink', async () => {
    const { app, plan } = await createApp('linked', answeredPlan())
    await writeFile(plan, JSON.stringify(answeredPlan(), null, 1), 'utf8')
    const link = join(ROOT, 'linked-alias')
    await symlink(app, link, 'dir')
    const report = await planApproveFile(plan, { app: planAppState(), appRoot: link, now: NOW })
    expect(report.stamped).toBeDefined()
  })

  test('should refuse to stamp when git cannot say whether the tree is clean', async () => {
    const { app, plan } = await createApp('status-fails', answeredPlan())
    const exec: CapturedExec = async (command, cwd, options) =>
      command[1] === 'status' ? { exitCode: 128, stdout: '', stderr: 'fatal: index file corrupt' } : runCaptured(command, cwd, options)
    await expect(planApproveFile(plan, { app: planAppState(), appRoot: app, exec })).rejects.toThrow(/Cannot tell whether the working tree .* is clean.*index file corrupt/s)
  })

  test('should refuse an approvals file that will not read, before the plan is rewritten', async () => {
    const { app, plan } = await createApp('unreadable', answeredPlan())
    await writeFile(planApprovalsPath(plan), '{ not json', 'utf8')
    const before = await readFile(plan, 'utf8')

    await expect(planApproveFile(plan, { app: planAppState(), appRoot: app })).rejects.toThrow(/is not valid JSON.*will not replace it/s)
    expect(await readFile(plan, 'utf8')).toBe(before)
    expect(await readFile(planApprovalsPath(plan), 'utf8')).toBe('{ not json')
  })
})

/** The fixture plus a policy the plan renames and a resource it drops, so an add, a rename and a drop can all be built. */
function reshapingPlan(): Record<string, unknown> {
  const document = answeredPlan()
  ;(document.policies as unknown[]).push({ id: 'policy.post', change: { kind: 'rename', from: 'PostPolicy' }, name: 'ArticlePolicy', model: 'model.post', abilities: [] })
  ;(document.resources as unknown[]).push({ id: 'resource.post', change: { kind: 'drop', reason: 'Posts render without a resource' }, name: 'PostResource', model: 'model.post', fields: [] })
  return document
}

const COMMENT_TABLE = `
export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
})
`

/** Commits the plan's model add, its policy rename and its resource drop, as a finished step leaves them. */
async function buildReshapingSteps(app: string): Promise<void> {
  await writeWorkspaceFiles(app, {
    'app/Models/Comment.ts': "import { defineModel } from '@guren/core'\nimport { comments } from '@/db/schema'\n\nexport class Comment extends defineModel(comments) {}\n",
    'app/Policies/ArticlePolicy.ts': 'export class ArticlePolicy {}\n',
    'db/schema.ts': `${PLAN_APP_FILES['db/schema.ts']}${COMMENT_TABLE}`,
  })
  await rm(join(app, 'app/Policies/PostPolicy.ts'))
  await rm(join(app, 'app/Http/Resources/PostResource.ts'))
  git(app, 'add', '-A')
  git(app, 'commit', '-q', '-m', 'build')
}

type EditablePlan = { scope: { goals: string[] }; policies: Array<Record<string, unknown>>; resources: Array<Record<string, unknown>> }

async function editPlan(plan: string, edit: (document: EditablePlan) => void): Promise<void> {
  const document = JSON.parse(await readFile(plan, 'utf8')) as EditablePlan
  edit(document)
  await writeFile(plan, JSON.stringify(document), 'utf8')
}

/** An edit outside every element: the hash moves, and no element's facts do. */
async function editGoal(plan: string): Promise<void> {
  await editPlan(plan, (document) => document.scope.goals.push('See who wrote a comment'))
}

describe('guren plan:approve after implementation starts', () => {
  test('should re-approve an edited plan whose added, renamed and dropped elements are built, keeping its baseline', async () => {
    const { app, plan } = await createApp('reapprove', reshapingPlan())
    const log = spyOn(console, 'log').mockImplementation(() => {})
    let baseline: unknown
    try {
      await runCommand(builtinSubCommands['plan:approve'], { rawArgs: [plan, '--app', app] })
      baseline = (JSON.parse(await readFile(plan, 'utf8')) as { baseline: unknown }).baseline
      await buildReshapingSteps(app)
      await editGoal(plan)
      await runCommand(builtinSubCommands['plan:approve'], { rawArgs: [plan, '--app', app, '--json'] })
      const report = JSON.parse(String(log.mock.calls.at(-1)![0])) as PlanApproveReport
      expect(report.stamped).toBeUndefined()
      expect(report.alreadyApproved).toBe(false)
      expect(report.builtByPlan!.sort()).toEqual(['model.comment', 'policy.post', 'resource.post'])
    } finally {
      log.mockRestore()
    }
    const written = JSON.parse(await readFile(plan, 'utf8')) as Record<string, unknown>
    expect(written.baseline).toEqual(baseline)
    expect((await readPlanApprovals(plan)).value!.approvals.map((approval) => approval.hash)).toEqual([
      expect.any(String),
      planHash(PlanSchema.parse(written)),
    ])

    // The page settles the same findings rather than pinning them as failures.
    const rendered = await renderPlanFile(plan, { app: () => loadPlanAppState(app), output: join(app, 'page.html') })
    expect(rendered.checks.filter((result) => result.status === 'fail')).toEqual([])
    expect(rendered.checks.find((result) => result.elementId === 'policy.post')).toMatchObject({ key: 'plan:app-missing', status: 'pass', message: expect.stringMatching(/^Built by this plan: the name is gone because the plan removed it/) })
  })

  test('should settle an added validator once its file exports the planned schema symbol', async () => {
    const { app, plan } = await createApp('reapprove-validator', answeredPlan())
    await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    await writeWorkspaceFiles(app, { 'app/Http/Validators/CommentValidator.ts': 'export const CommentPayloadSchema = {}\n' })
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'validator')
    await editGoal(plan)

    const report = await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    expect(report.builtByPlan).toEqual(['validator.comment'])
  })

  test('should warn rather than refuse on a built validator a baseline stamped before validators were read', async () => {
    const { app, plan } = await createApp('reapprove-legacy-validator', answeredPlan())
    // Such a baseline holds a hash for every element but the validators.
    const legacy = async () => ({ ...(await loadPlanAppState(app)), validators: { unreadable: 'validators were not read' } })
    await planApproveFile(plan, { app: legacy, appRoot: app, allowUnstamped: true, now: NOW })
    const { baseline } = JSON.parse(await readFile(plan, 'utf8')) as { baseline: { contextHash: Record<string, string> } }
    expect(baseline.contextHash).not.toHaveProperty('validator.comment')
    await writeWorkspaceFiles(app, { 'app/Http/Validators/CommentValidator.ts': 'export const CommentPayloadSchema = {}\n' })
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'validator')
    await editGoal(plan)

    const report = await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    expect(report.builtByPlan ?? []).toEqual([])
    const { checks } = await renderPlanFile(plan, { app: () => loadPlanAppState(app), output: join(app, 'page.html') })
    expect(checks.filter((result) => result.elementId === 'validator.comment' && result.status !== 'pass')).toEqual([
      expect.objectContaining({ key: 'plan:app-unjudged', status: 'warn', message: expect.stringContaining("holds a hash for none of this plan's validators") }),
    ])
  })

  test('should still refuse a validator a revision adds under a name the application already exports', async () => {
    const { app, plan } = await createApp('reapprove-validator-collision', answeredPlan())
    await writeWorkspaceFiles(app, { 'app/Http/Validators/PostValidator.ts': 'export const PostPayloadSchema = {}\n' })
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'post validator')
    await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    await editPlan(plan, (revised) => {
      ;(revised as unknown as { validators: Array<Record<string, unknown>> }).validators[0]!.name = 'PostPayloadSchema'
    })

    await expect(planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app })).rejects.toThrow(/validator\.comment: The validator "PostPayloadSchema" already exists/)
  })

  test('should settle an added route once it is registered under its name at its planned endpoint', async () => {
    const { app, plan } = await createApp('reapprove-route', reshapingPlan())
    await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    await editGoal(plan)
    // The fixture app has no routes file; the route the plan adds is what the scanners would read once it is mounted.
    const withRoute = async () => {
      const state = await loadPlanAppState(app)
      return { ...state, routes: [{ name: 'comments.store', method: 'POST', path: '/posts/:postId/comments' }] }
    }

    const { checks } = await renderPlanFile(plan, { app: withRoute, output: join(app, 'page.html') })
    const routeChecks = checks.filter((result) => result.elementId === 'route.comments.store' && result.key === 'plan:app-collision')
    expect(routeChecks.map((result) => result.status)).toEqual(['pass', 'pass'])
    const report = await planApproveFile(plan, { app: withRoute, appRoot: app, now: NOW })
    expect(report.builtByPlan).toEqual(['route.comments.store'])
  })

  test('should still refuse a collision the plan did not build: its table declared by another app root', async () => {
    const { app, plan } = await createApp('reapprove-foreign', reshapingPlan())
    await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    await writeWorkspaceFiles(app, {
      'modules/billing/index.ts': 'export default {}\n',
      'modules/billing/db/schema.ts': `import { pgTable, serial, text } from 'drizzle-orm/pg-core'\n${COMMENT_TABLE}`,
    })
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'billing')
    await editGoal(plan)

    await expect(planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app })).rejects.toThrow(/model\.comment: The table "comments" already exists in modules\/billing/)
  })

  test('should refuse a revision that turns an existing element into an add of the name it already had', async () => {
    const document = reshapingPlan()
    ;(document.policies as Array<Record<string, unknown>>).find((policy) => policy.id === 'policy.post')!.change = { kind: 'existing' }
    ;(document.policies as Array<Record<string, unknown>>).find((policy) => policy.id === 'policy.post')!.name = 'PostPolicy'
    const { app, plan } = await createApp('reapprove-existing-to-add', document)
    await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    await editPlan(plan, (revised) => {
      revised.policies.find((policy) => policy.id === 'policy.post')!.change = { kind: 'add' }
    })

    await expect(planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app })).rejects.toThrow(/policy\.post: The policy "PostPolicy" already exists/)
  })

  test('should refuse an added element a revision retargets onto a name the plan never built', async () => {
    const { app, plan } = await createApp('reapprove-retarget', reshapingPlan())
    await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    await editPlan(plan, (revised) => {
      revised.resources.find((resource) => resource.id === 'resource.comment')!.name = 'PostResource'
    })

    await expect(planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app })).rejects.toThrow(/resource\.comment: The resource "PostResource" already exists/)
  })

  test('should settle a drop a revision made of an existing element someone else already deleted, as freshness does', async () => {
    const document = reshapingPlan()
    ;(document.resources as Array<Record<string, unknown>>).find((resource) => resource.id === 'resource.post')!.change = { kind: 'existing' }
    const { app, plan } = await createApp('reapprove-existing-to-drop', document)
    await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    await rm(join(app, 'app/Http/Resources/PostResource.ts'))
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'someone else')
    await editPlan(plan, (revised) => {
      revised.resources.find((resource) => resource.id === 'resource.post')!.change = { kind: 'drop', reason: 'already gone' }
    })

    const report = await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    expect(report.builtByPlan).toEqual(['resource.post'])
  })

  test('should not settle a model from its class alone while its table cannot be read', async () => {
    const { app, plan } = await createApp('reapprove-unreadable', reshapingPlan())
    await planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app, now: NOW })
    await buildReshapingSteps(app)
    await editGoal(plan)
    // The class reads and collides; the table, the other half of model.comment, does not read.
    const unreadTables = async () => ({ ...(await loadPlanAppState(app)), tables: { unreadable: 'db/schema.ts could not be imported' } })

    await expect(planApproveFile(plan, { app: unreadTables, appRoot: app })).rejects.toThrow(/model\.comment: The model class "Comment" already exists/)
  })

  test('should still refuse a draft whose added element already exists', async () => {
    const { app, plan } = await createApp('draft-built', reshapingPlan())
    await buildReshapingSteps(app)

    await expect(planApproveFile(plan, { app: () => loadPlanAppState(app), appRoot: app })).rejects.toThrow(/model\.comment: The model class "Comment" already exists/)
    expect(JSON.parse(await readFile(plan, 'utf8'))).not.toHaveProperty('baseline')
  })
})

describe('plan:status freshness', () => {
  test('should judge an approved plan against its stamp, and say nothing of a draft', async () => {
    const { app, plan } = await createApp('status', answeredPlan())
    const draft = await planStatusFile(plan, { app: planAppState() })
    expect(draft.freshness).toBeUndefined()

    await planApproveFile(plan, { app: planAppState(), appRoot: app, now: NOW })
    const fresh = await planStatusFile(plan, { app: planAppState(), appRoot: app })
    expect(fresh.freshness!.summary).toMatchObject({ stale: 0, unstamped: 0 })

    const moved = await planStatusFile(plan, { app: planAppState({ tables: [{ identifier: 'posts', tableName: 'posts', columns: ['title'] }] }), appRoot: app })
    expect(moved.freshness!.elements.find((element) => element.id === 'column.post.id')!.verdict).toBe('stale')
    const text = formatPlanStatus(moved)
    expect(text).toContain('Against the approved baseline: fresh ')
    expect(text).toContain('  stale  column.post.id: What the scanners read for it changed since approval, to neither what was stamped nor what the plan leaves.')
    expect(text).not.toContain('  unjudged:')

    const unreadValidators = await planStatusFile(plan, { app: planAppState({ validators: { unreadable: 'a validator file did not parse' } }), appRoot: app })
    expect(formatPlanStatus(unreadValidators)).toContain('  unjudged: validator.comment')
  })
})

describe('writeFileAtomic', () => {
  test('should keep the mode of the file it replaces, and write through a symlink to the file it names', async () => {
    const dir = join(ROOT, 'atomic')
    await writeWorkspaceFiles(dir, { 'real.json': '{}\n' })
    const real = join(dir, 'real.json')
    await chmod(real, 0o640)
    const link = join(dir, 'link.json')
    await symlink(real, link)

    await writeFileAtomic(link, '{"a":1}\n')

    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readFile(real, 'utf8')).toBe('{"a":1}\n')
    expect((await stat(real)).mode & 0o777).toBe(0o640)
    expect((await readdir(dir)).sort()).toEqual(['link.json', 'real.json'])
  })
})
