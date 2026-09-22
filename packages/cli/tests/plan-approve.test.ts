import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { chmod, lstat, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { planApproveFile, type PlanApproveReport } from '../src/plan-approve'
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
    expect(report.stamped!.unstamped.map((entry) => entry.id)).toContain('validator.comment')
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

  test('should refuse while a section other than validators cannot be read, unless told to approve without it', async () => {
    const { app, plan } = await createApp('unstamped', answeredPlan())
    const before = await readFile(plan, 'utf8')
    const unread = planAppState({ tables: { unreadable: 'db/schema.ts declared no table this parser could read' } })

    await expect(planApproveFile(plan, { app: unread, appRoot: app })).rejects.toThrow(
      /The application's tables could not be read, so these elements would get no context hash[\s\S]*  model\.post: [\s\S]*--allow-unstamped/,
    )
    expect(await readFile(plan, 'utf8')).toBe(before)

    const report = await planApproveFile(plan, { app: unread, appRoot: app, allowUnstamped: true, now: NOW })
    expect(report.stamped!.unstamped.map((entry) => entry.id)).toEqual(expect.arrayContaining(['model.post', 'column.post.id', 'validator.comment']))
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
    expect(text).toContain('  unjudged: validator.comment')
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
