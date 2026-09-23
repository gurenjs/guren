import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { planApproveFile } from '../src/plan-approve'
import { formatPlanNext, planNextFile, type PlanNextReport } from '../src/plan-next'
import { parsePlanDocument } from '../src/plan-render'
import { planWaiveFile } from '../src/plan-waive'
import type { PlanAppState } from '../src/plan/app-state'
import { MAX_STEP_CONTINUATIONS as MAX_CONTINUATIONS } from '../src/plan-stop-hook'
import { HELD_STEP_REMEDY } from '../src/plan/step-context'
import { planDigest, PLAN_STATE_VERSION, type PlanState, type PlanStepRecord } from '../src/plan/state'
import { derivePlanTasks, planStepIds } from '../src/plan/tasks'
import { sha256 } from '../src/plan/verification'
import { writeWorkspaceFiles } from './helpers'
import { approvedAgainst, approvePlanFile, loadCommentsPlan, PLAN_APP_FILES, planAppState, type PlanAppStateInput } from './plan-fixture'

// A draft never has the application read, so an app here is a directory with a plan; an approved
// plan is handed the application as `app`, or read from a committed one on disk.
const PLAN = parsePlanDocument(loadCommentsPlan())
const DIGEST = planDigest(PLAN)
const STEPS = planStepIds(derivePlanTasks(PLAN))
const [SCAFFOLD, TESTS, DATA, HTTP] = STEPS as [string, string, string, string]
const NOW = () => new Date('2026-09-21T10:00:00.000Z')

let ROOT: string

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
}

/** A record that stands: verified against this plan at the hash `lib.ts` has in the app. */
async function holding(app: string): Promise<PlanStepRecord> {
  return {
    outcome: 'verified',
    planDigest: DIGEST,
    ranAt: '2026-09-21T00:00:00.000Z',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    waived: [],
    fingerprint: { files: { 'lib.ts': sha256(await readFile(join(app, 'lib.ts'))) }, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'h' } },
  }
}

async function writeState(app: string, state: Partial<PlanState>): Promise<void> {
  await writeWorkspaceFiles(app, { '.guren/plans/comments.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: {}, ...state }) })
}

async function createApp(name: string, state?: Partial<PlanState>): Promise<{ app: string; plan: string }> {
  const app = join(ROOT, name)
  await writeWorkspaceFiles(app, {
    'package.json': JSON.stringify({ name, type: 'module', dependencies: { '@guren/inertia-client': '*' } }),
    'lib.ts': 'export const a = 1\n',
    'comments.plan.json': JSON.stringify(loadCommentsPlan()),
  })
  if (state) await writeState(app, state)
  return { app, plan: join(app, 'comments.plan.json') }
}

async function readState(app: string): Promise<PlanState> {
  return JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as PlanState
}

describe('plan:next', () => {
  beforeAll(async () => {
    ROOT = await mkdtemp(join(tmpdir(), 'guren-plan-next-'))
  })

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
  })

  test('should return the first step in task order with its elements, behaviours and verify commands, and mark it', async () => {
    const { app, plan } = await createApp('first')

    const report = await planNextFile(plan, { appRoot: app, now: NOW })

    expect(report.verified).toEqual([])
    expect(report.step).toMatchObject({ id: SCAFFOLD, kind: 'scaffold', taskId: 'task/entity/model.comment', task: { kind: 'entity', name: 'Comment' }, verify: ['codegen', 'typecheck'], elements: [] })
    expect(report.step!.generates).toContain('model.comment')
    expect(report.stateFile).toBe('.guren/plans/comments.state.json')
    expect((await readState(app)).active).toEqual({ plan: 'comments.plan.json', step: SCAFFOLD, startedAt: '2026-09-21T10:00:00.000Z', continuations: 0 })
    // The mark's `.gitignore` ignores itself, so a plan loop leaves no untracked file behind; one that does not gains the line.
    expect(await readFile(join(app, '.guren/plans/.gitignore'), 'utf8')).toBe('*.state.json\n.gitignore\n')
    await writeFile(join(app, '.guren/plans/.gitignore'), '*.state.json\nnotes/', 'utf8')
    await planNextFile(plan, { appRoot: app, now: NOW })
    expect(await readFile(join(app, '.guren/plans/.gitignore'), 'utf8')).toBe('*.state.json\nnotes/\n.gitignore\n')

    const again = await planNextFile(plan, { appRoot: app, now: NOW })
    expect(again.step!.id).toBe(SCAFFOLD)
  })

  test('should name what a scaffold would generate without claiming a generator writes it', async () => {
    const { app, plan } = await createApp('scaffold-text')

    const text = formatPlanNext(await planNextFile(plan, { appRoot: app, now: NOW }), 'comments.plan.json')

    expect(text).toContain('The elements a scaffold would generate: model.comment')
    expect(text).toContain('No generator for this step ships yet, so it completes on its verify commands')
    expect(text).not.toContain('Generates a first version')
  })

  test('should keep two plans in the docs/plans/<slug>/plan.json layout in state files of their own', async () => {
    const app = join(ROOT, 'layout')
    await writeWorkspaceFiles(app, {
      'package.json': JSON.stringify({ name: 'layout', type: 'module', dependencies: { '@guren/inertia-client': '*' } }),
      'docs/plans/comments/plan.json': JSON.stringify(loadCommentsPlan()),
      'docs/plans/billing/plan.json': JSON.stringify(loadCommentsPlan()),
    })

    const comments = await planNextFile(join(app, 'docs/plans/comments/plan.json'), { appRoot: app, now: NOW })
    const billing = await planNextFile(join(app, 'docs/plans/billing/plan.json'), { appRoot: app, now: NOW })

    expect([comments.stateFile, billing.stateFile]).toEqual(['.guren/plans/comments.state.json', '.guren/plans/billing.state.json'])
    const mark = async (slug: string): Promise<string | undefined> =>
      (JSON.parse(await readFile(join(app, `.guren/plans/${slug}.state.json`), 'utf8')) as PlanState).active?.plan
    expect([await mark('comments'), await mark('billing')]).toEqual(['docs/plans/comments/plan.json', 'docs/plans/billing/plan.json'])
  })

  test('should skip the steps whose record still holds and carry the elements of the one it returns', async () => {
    const { app, plan } = await createApp('holding')
    const record = await holding(app)
    await writeState(app, { steps: { [SCAFFOLD]: record, [TESTS]: record, [DATA]: record } })

    const report = await planNextFile(plan, { appRoot: app, now: NOW })

    expect(report.verified).toEqual([SCAFFOLD, TESTS, DATA])
    expect(report.step!.id).toBe(HTTP)
    expect(report.step!.elements.map((element) => [element.id, element.section])).toEqual(
      expect.arrayContaining([
        ['action.comments.store', 'actions'],
        ['route.comments.store', 'routes'],
        ['validator.comment', 'validators'],
      ]),
    )
    expect(report.step!.elements.find((element) => element.id === 'route.comments.store')!.element).toMatchObject({ id: 'route.comments.store', method: 'POST' })
    expect(report.step!.acceptance.map((behaviour) => behaviour.id)).toEqual(['AC-comments-1', 'AC-comments-2', 'AC-comments-3', 'AC-comments-4'])

    // A record of another plan, or one whose file changed, does not hold.
    await writeFile(join(app, 'lib.ts'), 'export const a = 2\n', 'utf8')
    expect((await planNextFile(plan, { appRoot: app, now: NOW })).step!.id).toBe(SCAFFOLD)
  })

  test('should count a step done on a verified record that fingerprints nothing, as a scaffold step or a drop leaves, and name it when the plan is done', async () => {
    const { app, plan } = await createApp('scaffold')
    const record = { ...(await holding(app)), fingerprint: { files: {}, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'h' } } }
    await writeState(app, { steps: { [SCAFFOLD]: record, [TESTS]: { ...record, outcome: 'incomplete' } } })

    const report = await planNextFile(plan, { appRoot: app, now: NOW })

    expect(report.verified).toEqual([SCAFFOLD])
    expect(report.onCommandsAlone).toEqual([SCAFFOLD])
    expect(report.step!.id).toBe(TESTS)

    const filed = await holding(app)
    await writeState(app, { steps: Object.fromEntries(STEPS.map((id) => [id, id === SCAFFOLD ? record : filed])) })
    const done = await planNextFile(plan, { appRoot: app, now: NOW })
    expect(done.step).toBeNull()
    expect(formatPlanNext(done, 'comments.plan.json')).toContain(`\n${SCAFFOLD}: verified on the commands alone, nothing fingerprinted; plan:status shows what their elements are at.`)
  })

  test('should report that every step is verified and clear the mark, uncommitted work or not', async () => {
    const { app, plan } = await createApp('done')
    const record = await holding(app)
    await writeState(app, { steps: Object.fromEntries(STEPS.map((id) => [id, record])), active: { plan: 'comments.plan.json', step: HTTP, startedAt: 't', continuations: 1 } })

    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')
    await writeFile(join(app, 'extra.ts'), 'export const b = 2\n', 'utf8')

    const report = await planNextFile(plan, { appRoot: app, now: NOW })

    expect(report.step).toBeNull()
    expect(report.verified).toEqual(STEPS)
    expect((await readState(app)).active).toBeUndefined()
    // Nothing of the plan is written in this application, so plan:close would refuse every element, and says why.
    expect(report.unverified).toContainEqual({
      id: 'resource.comment',
      state: 'planned',
      moves: `Implement it, then run \`bunx guren plan:verify ${plan} --step task/entity/model.comment/http\`; or waive it: \`bunx guren plan:waive ${plan} resource.comment --reason "<why>"\``,
    })
    const text = formatPlanNext(report, 'comments.plan.json')
    expect(text).toContain(
      `Every step is verified, and these elements are not: plan:close refuses the plan until each is verified or waived.\n  model.post (planned): The element this alters was not found\n    Implement it, then run \`bunx guren plan:verify ${plan} --step task/entity/model.comment/data\`;`,
    )
    expect(text).not.toContain('Nothing is left to implement')

    const unread = await planNextFile(plan, { appRoot: app, now: NOW, statusApp: () => Promise.reject(new Error('the schema threw')) })
    expect(unread.unverifiedUnreadable).toBe('the schema threw')
    expect(formatPlanNext(unread, 'comments.plan.json')).toContain('Every step is verified. The elements were not judged, so plan:status may still list some that plan:close refuses: the schema threw')
    expect(formatPlanNext(unread, 'comments.plan.json')).not.toContain('Nothing is left to implement')
  })

  test('should refuse uncommitted changes unless they are the marked step\'s own', async () => {
    const { app, plan } = await createApp('dirty')
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')

    // A clean tree, and the state the mark writes, are not changes; nor is a state `.gitignore` an earlier run left untracked or tracked.
    await writeWorkspaceFiles(app, { '.guren/plans/.gitignore': '*.state.json\n' })
    await planNextFile(plan, { appRoot: app, now: NOW })
    await writeFile(join(app, '.guren/plans/.gitignore'), '*.state.json\n', 'utf8')
    git(app, 'add', '-f', '.guren/plans/.gitignore')
    git(app, 'commit', '-q', '-m', 'tracked state ignore')
    await planNextFile(plan, { appRoot: app, now: NOW })
    await writeFile(join(app, 'lib.ts'), 'export const a = 2\n', 'utf8')
    // The dirty tree is the marked step's, so asking for it again is allowed.
    expect((await planNextFile(plan, { appRoot: app, now: NOW })).step!.id).toBe(SCAFFOLD)

    // Once that step holds, the leftover would land in the next step's commit.
    const record = await holding(app)
    await writeState(app, { steps: { [SCAFFOLD]: record }, active: { plan: 'comments.plan.json', step: SCAFFOLD, startedAt: 't', continuations: 0 } })
    await expect(planNextFile(plan, { appRoot: app, now: NOW })).rejects.toThrow(/uncommitted changes \(paths relative to the repository root\), and one step is one commit\. Commit or discard them first:\n {2}M lib\.ts$/)
  })

  test('should leave the rendered page and a leftover temporary out of the dirty reading, and still refuse an unrelated file', async () => {
    const { app, plan } = await createApp('rendered')
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')
    await writeState(app, { steps: { [SCAFFOLD]: await holding(app) } })

    // What plan:render and an interrupted atomic write leave beside the plan; neither is a step's work.
    await writeWorkspaceFiles(app, { 'comments.plan.html': '<html></html>\n', '.comments.plan.html.1.2.tmp': '{}\n' })
    expect((await planNextFile(plan, { appRoot: app, now: NOW })).step!.id).toBe(TESTS)

    await writeWorkspaceFiles(app, { 'notes.md': 'x\n' })
    await writeState(app, { steps: { [SCAFFOLD]: await holding(app) } })
    await expect(planNextFile(plan, { appRoot: app, now: NOW })).rejects.toThrow(/first:\n {2}\?\? notes\.md$/)
  })

  test('should leave out an untracked page in a plan directory, and refuse an uncommitted decision log or plan edit', async () => {
    const app = join(ROOT, 'plan-dir')
    const plan = join(app, 'docs/plans/comments/plan.json')
    await writeWorkspaceFiles(app, {
      'package.json': JSON.stringify({ name: 'plan-dir', type: 'module', dependencies: { '@guren/inertia-client': '*' } }),
      'docs/plans/comments/plan.json': JSON.stringify(loadCommentsPlan()),
    })
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')
    const unmarked = { steps: {}, active: { plan: 'docs/plans/comments/plan.json', step: 'elsewhere', startedAt: 't', continuations: 0 } }
    await writeWorkspaceFiles(app, { 'docs/plans/comments/plan.html': '<html></html>\n' })
    await writeState(app, unmarked)
    expect((await planNextFile(plan, { appRoot: app, now: NOW })).step!.id).toBe(SCAFFOLD)

    // The records are committed: a waiver in the log steers which step comes back, so it is nobody's step to carry.
    await writeWorkspaceFiles(app, { 'docs/plans/comments/decisions.json': '{}\n' })
    await writeState(app, unmarked)
    await expect(planNextFile(plan, { appRoot: app, now: NOW })).rejects.toThrow(/first:\n {2}\?\? docs\/plans\/comments\/decisions\.json$/)

    await rm(join(app, 'docs/plans/comments/decisions.json'))
    await writeFile(plan, JSON.stringify({ ...loadCommentsPlan(), title: 'Edited' }), 'utf8')
    await writeState(app, unmarked)
    await expect(planNextFile(plan, { appRoot: app, now: NOW })).rejects.toThrow(/first:\n +M docs\/plans\/comments\/plan\.json$/)
  })

  test('should leave a tracked state file out of the dirty reading, in an application below the repository root', async () => {
    // Porcelain paths are relative to the repository root: the exclusion has to hold when that is not the app.
    const { app, plan } = await createApp('nested/apps/web')
    const repo = join(ROOT, 'nested')
    await writeWorkspaceFiles(app, { '.guren/plans/.gitignore': '*.state.json\n' })
    // Tracked as well, so the state-file exclude is what keeps its rewrite out of the reading.
    await writeState(app, { steps: {} })
    git(repo, 'init', '-q')
    git(repo, 'add', '-A', '-f')
    git(repo, 'commit', '-q', '-m', 'init')

    // The only change is the line ensurePlanStateIgnored appends to the tracked file.
    const report = await planNextFile(plan, { appRoot: app, now: NOW })
    expect(report.step!.id).toBe(SCAFFOLD)

    // A change beside the state directory is still a change.
    await writeFile(join(app, '.guren/plans-old'), 'x\n', 'utf8')
    await writeState(app, { steps: { [SCAFFOLD]: await holding(app) } })
    await expect(planNextFile(plan, { appRoot: app, now: NOW })).rejects.toThrow(/first:\n {2}\?\? apps\/web\/\.guren\/plans-old$/)
  })

  test('should report a stall once and give the step a fresh mark', async () => {
    const stalled = { at: '2026-09-21T09:00:00.000Z', reason: '3 continuations on this step', output: `${SCAFFOLD}: failed (3 ms)\n  fail     typecheck   bun run typecheck` }
    const { app, plan } = await createApp('stalled', { active: { plan: 'comments.plan.json', step: SCAFFOLD, startedAt: 't', continuations: 3, lastSignature: 'x', stalled } })

    const report = await planNextFile(plan, { appRoot: app, now: NOW })

    expect(report.step!.stalled).toEqual(stalled)
    expect((await readState(app)).active).toEqual({ plan: 'comments.plan.json', step: SCAFFOLD, startedAt: '2026-09-21T10:00:00.000Z', continuations: 0 })
    const text = formatPlanNext(report, 'comments.plan.json')
    expect(text).toContain('Stalled 2026-09-21T09:00:00.000Z: 3 continuations on this step')
    expect(text).toContain('    fail     typecheck   bun run typecheck')
    expect(text).toContain('A stall is a person\u2019s decision: fix the environment, edit the plan (and approve it), or accept an element incomplete with')
    expect(text).toContain('  bunx guren plan:waive comments.plan.json <element-id> --reason "<why>"')
    // The mark it wrote is a fresh one, so the next run is a plain step.
    expect((await planNextFile(plan, { appRoot: app, now: NOW })).step!.stalled).toBeUndefined()
  })

  test('should keep the mark of a step it returns again, continuations included', async () => {
    const active = { plan: 'comments.plan.json', step: SCAFFOLD, startedAt: '2026-09-20T00:00:00.000Z', continuations: 2, lastSignature: 'sig' }
    const { app, plan } = await createApp('resumed', { active })

    await planNextFile(plan, { appRoot: app, now: NOW })

    expect((await readState(app)).active).toEqual(active)
  })

  test('should let a waiver carry a step whose record rests on one, and return that step again once the waiver is gone', async () => {
    const approved = approvedAgainst(loadCommentsPlan())
    const app = join(ROOT, 'waived')
    await writeWorkspaceFiles(app, {
      'package.json': JSON.stringify({ name: 'waived', type: 'module', dependencies: { '@guren/inertia-client': '*' } }),
      'lib.ts': 'export const a = 1\n',
      'comments.plan.json': JSON.stringify(approved),
    })
    const plan = join(app, 'comments.plan.json')
    await approvePlanFile(plan)
    const record = { ...(await holding(app)), planDigest: planDigest(parsePlanDocument(approved)), waived: ['policy.comment'] }
    await writeState(app, { steps: { [SCAFFOLD]: record } })
    await planWaiveFile(plan, { elementIds: ['policy.comment'], reason: 'the policy lands in the next plan', now: NOW })

    const carried = await planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })
    await planWaiveFile(plan, { elementIds: ['policy.comment'], remove: true })
    const withdrawn = await planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })

    expect(carried.verified).toEqual([SCAFFOLD])
    expect(carried.step?.id).toBe(TESTS)
    expect(withdrawn.verified).toEqual([])
    expect(withdrawn.step?.id).toBe(SCAFFOLD)
  })

  test('should read the application once, with detail, when every step of an approved plan is verified', async () => {
    const approved = approvedAgainst(loadCommentsPlan())
    const { app, plan } = await createApp('approved-done')
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(approved) })
    await approvePlanFile(plan)
    const record = { ...(await holding(app)), planDigest: planDigest(parsePlanDocument(approved)) }
    await writeState(app, { steps: Object.fromEntries(STEPS.map((id) => [id, record])) })
    const reads: string[] = []

    const report = await planNextFile(plan, {
      appRoot: app,
      now: NOW,
      app: () => (reads.push('freshness'), Promise.resolve(planAppState())),
      statusApp: () => (reads.push('detail'), Promise.resolve(planAppState())),
    })

    expect(report.step).toBeNull()
    expect(reads).toEqual(['detail'])
  })

  test('should mark a step\u2019s waived elements apart from the ones to implement', async () => {
    const approved = approvedAgainst(loadCommentsPlan())
    const { app, plan } = await createApp('waived-elements')
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(approved) })
    await approvePlanFile(plan)
    const record = { ...(await holding(app)), planDigest: planDigest(parsePlanDocument(approved)) }
    await writeState(app, { steps: { [SCAFFOLD]: record, [TESTS]: record, [DATA]: record } })
    // `git config` faked away, so the waiver's authorship is not this machine's.
    await planWaiveFile(plan, { elementIds: ['policy.comment'], reason: 'the policy lands in the next plan', now: NOW, exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }) })

    const report = await planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })
    const text = formatPlanNext(report, 'comments.plan.json')

    expect(report.step!.id).toBe(HTTP)
    const waived = report.step!.elements.filter((element) => element.waived)
    expect(waived.map((element) => element.id)).toEqual(['policy.comment'])
    expect(waived[0]!.waived).toEqual({ reason: 'the policy lands in the next plan', at: '2026-09-21T10:00:00.000Z' })
    expect(report.step!.elements.find((element) => element.id === 'action.comments.store')!.waived).toBeUndefined()
    expect(text).toContain('Waived, not to be implemented:\n  policy.comment (policies): the policy lands in the next plan (2026-09-21T10:00:00.000Z)')
    expect(text).toContain('The step verifies without them')
    expect(text).not.toContain('  policy.comment (policies)\n')
  })

  test('should report a decision log it could not read, having applied no waiver', async () => {
    const { app, plan } = await createApp('unreadable-log')
    await writeWorkspaceFiles(app, { 'comments.decisions.json': '{ "decisionsVersion": 2 }\n' })

    const report = await planNextFile(plan, { appRoot: app, now: NOW })

    expect(report.decisionsUnreadable).toContain('does not match the decision log schema')
    // Named in the report, so a --json consumer does not read the path out of the prose.
    expect(report.decisionsFile).toBe('comments.decisions.json')
    expect(formatPlanNext(report, 'comments.plan.json')).toContain('Decision log not read, so no waiver was applied:')
  })

  test('should refuse a plan whose hash no approval names before it reads the tree or marks a step, and hand out work once approved', async () => {
    const approved = approvedAgainst(loadCommentsPlan())
    const { app, plan } = await createApp('unapproved')
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(approved) })
    const next = () => runCommand(builtinSubCommands['plan:next'] as CommandDef, { rawArgs: [plan, '--app', app] })

    await expect(next()).rejects.toThrow(`${plan} is not approved at its current hash`)
    await expect(next()).rejects.toThrow(`Run guren plan:approve ${plan}`)
    await expect(readState(app)).rejects.toThrow('ENOENT')

    await approvePlanFile(plan)
    expect((await planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })).step!.id).toBe(SCAFFOLD)

    // An edit after approval moves the hash, which the approval does not name.
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify({ ...approved, title: 'Comments, edited' }) })
    await expect(planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })).rejects.toThrow('is not approved at its current hash')
  })

  test('should refuse a plan with a baseline while its approvals file will not read', async () => {
    const { app, plan } = await createApp('unreadable-approvals')
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(approvedAgainst(loadCommentsPlan())), 'comments.approvals.json': '{' })

    const refusal = planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })
    await expect(refusal).rejects.toThrow('is not valid JSON')
    await expect(planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })).rejects.toThrow('so no step of it is handed out. Fix the approvals file')
    await expect(readState(app)).rejects.toThrow('ENOENT')
  })

  test('should refuse an approved plan whose baseline was deleted, and hand out a draft nobody approved', async () => {
    const approved = approvedAgainst(loadCommentsPlan())
    const { app, plan } = await createApp('baseline-removed')
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(approved) })
    await approvePlanFile(plan)
    const { baseline: _baseline, ...draft } = approved
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(draft) })

    await expect(planNextFile(plan, { appRoot: app, now: NOW })).rejects.toThrow(`${plan} has lost its baseline, but 1 approval(s) are recorded beside it, so no step of it is handed out`)
    await expect(readState(app)).rejects.toThrow('ENOENT')

    await rm(join(app, 'comments.approvals.json'))
    expect((await planNextFile(plan, { appRoot: app, now: NOW })).step!.id).toBe(SCAFFOLD)
  })

  test('should indent every line of a stall reason under the line that names it', async () => {
    const stalled = { at: '2026-09-21T09:30:00.000Z', reason: 'first line\nsecond line', output: 'out one\nout two' }
    const { app, plan } = await createApp('stall-lines', { active: { plan: 'comments.plan.json', step: SCAFFOLD, startedAt: '2026-09-21T09:00:00.000Z', continuations: 3, stalled } })

    const text = formatPlanNext(await planNextFile(plan, { appRoot: app, now: NOW }), 'comments.plan.json')

    expect(text).toContain('Stalled 2026-09-21T09:30:00.000Z: first line\n  second line\n  out one\n  out two\n')
  })

  describe('formatting', () => {
    const log = spyOn(console, 'log')

    afterEach(() => {
      log.mockClear()
    })

    afterAll(() => {
      log.mockRestore()
    })

    test('should print the step for a person and the structure for --json', async () => {
      const { app, plan } = await createApp('format')
      const record = await holding(app)
      await writeState(app, { steps: { [SCAFFOLD]: record } })
      log.mockImplementation(() => {})

      await runCommand(builtinSubCommands['plan:next'] as CommandDef, { rawArgs: [plan, '--app', app] })
      const text = String(log.mock.calls[0]![0])
      await runCommand(builtinSubCommands['plan:next'] as CommandDef, { rawArgs: [plan, '--app', app, '--json'] })
      const json = JSON.parse(String(log.mock.calls[1]![0])) as PlanNextReport

      expect(text).toContain(`Verified: ${SCAFFOLD}`)
      expect(text).toContain(`Next: ${TESTS}\n  task: entity Comment (task/entity/model.comment)\n  verify: codegen → tests:fail`)
      expect(text).toContain('Behaviours to write, as test titles `[<id>] <description>`, failing:\n  [AC-comments-1] ')
      expect(text).toMatch(/ {6}\w+; actor .*; route route\.comments\.store; .*expect /)
      expect(text).toContain(`Implement this step only, then run \`bunx guren plan:verify ${plan} --step ${TESTS}\` and commit once it is verified.`)
      expect(text).toContain('Marked in .guren/plans/comments.state.json')
      expect(json.reportVersion).toBe(1)
      expect(json.step).toMatchObject({ id: TESTS, kind: 'tests', acceptance: expect.arrayContaining([expect.objectContaining({ id: 'AC-comments-1' })]) })
    })
  })
})

/**
 * The comments fixture with two more tasks: `model.post/http` owns an `alter` route naming an
 * `existing` action, and `model.tag` is a slice that depends on nothing of the comments.
 */
function threeTaskPlan(): Record<string, unknown> {
  const document = loadCommentsPlan() as Record<string, Array<Record<string, unknown>>>
  document.models!.push({
    id: 'model.tag',
    change: { kind: 'add' },
    name: 'Tag',
    table: 'tags',
    columns: [{ id: 'column.tag.id', name: 'id', change: { kind: 'add' }, type: 'integer', nullable: false, unique: false, index: false, primaryKey: true }],
    relationships: [],
    fillable: [],
  })
  document.controllers!.push({
    id: 'controller.posts',
    change: { kind: 'existing' },
    className: 'PostController',
    actions: [{ id: 'action.posts.index', change: { kind: 'existing' }, name: 'index', authorization: { middleware: [] }, response: { kind: 'json', description: 'the posts' }, rules: [] }],
  })
  document.routes!.push({ id: 'route.posts.index', change: { kind: 'alter' }, method: 'GET', path: '/posts', name: 'posts.index', action: 'action.posts.index', middleware: ['auth'], bind: [] })
  return document
}

const POST_HTTP = 'task/entity/model.post/http'
const COMMENT = 'task/entity/model.comment'
const TAG_SCAFFOLD = 'task/entity/model.tag/scaffold'
const POST_MOVED: PlanAppStateInput = { models: [{ name: 'Post', module: 'blog' }, 'User'] }

describe('plan:next on stale context', () => {
  beforeAll(async () => {
    ROOT = await mkdtemp(join(tmpdir(), 'guren-plan-next-stale-'))
  })

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
  })

  async function approvedApp(name: string, document: Record<string, unknown>, standing: string[] = []): Promise<{ app: string; plan: string }> {
    const approved = approvedAgainst(document)
    const { app, plan } = await createApp(name)
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(approved) })
    await approvePlanFile(plan)
    const record = { ...(await holding(app)), planDigest: planDigest(parsePlanDocument(approved)) }
    await writeState(app, { steps: Object.fromEntries(standing.map((id) => [id, record])) })
    return { app, plan }
  }

  test('should block the step owning a stale element and the steps naming it, hold what waits on them, and return an unrelated step', async () => {
    const { app, plan } = await approvedApp('owner', threeTaskPlan(), [POST_HTTP, `${COMMENT}/scaffold`, `${COMMENT}/tests`])

    const report = await planNextFile(plan, { appRoot: app, app: planAppState(POST_MOVED), now: NOW })

    expect(report.held.map((step) => [step.id, step.stale.map((element) => [element.id, element.owned, element.through])])).toEqual([
      [`${COMMENT}/data`, [['model.post', true, ['model.comment', 'column.comment.postId']]]],
      [`${COMMENT}/http`, [['model.post', false, ['route.comments.store']]]],
    ])
    expect(report.waiting).toEqual([{ id: `${COMMENT}/pages`, on: [`${COMMENT}/data`, `${COMMENT}/http`] }])
    expect(report.step!.id).toBe(TAG_SCAFFOLD)
    expect(report.verified).toEqual([POST_HTTP, `${COMMENT}/scaffold`, `${COMMENT}/tests`])
    expect((await readState(app)).active!.step).toBe(TAG_SCAFFOLD)

    // The same plan against the application it was approved against blocks nothing.
    const fresh = await planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })
    expect(fresh.held).toEqual([])
    expect(fresh.step!.id).toBe(`${COMMENT}/data`)
  })

  test('should hold every step of a task waiting for a held one, and return a verified step to neither list', async () => {
    const document = loadCommentsPlan() as Record<string, Array<Record<string, unknown>>>
    // A reaction references a comment, so its slice waits for the comments task.
    document.models!.push({
      id: 'model.reaction',
      change: { kind: 'add' },
      name: 'Reaction',
      table: 'reactions',
      columns: [
        { id: 'column.reaction.id', name: 'id', change: { kind: 'add' }, type: 'integer', nullable: false, unique: false, index: false, primaryKey: true },
        { id: 'column.reaction.commentId', name: 'commentId', change: { kind: 'add' }, type: 'integer', nullable: false, unique: false, index: true, references: { model: 'model.comment', column: 'id', onDelete: 'cascade' } },
      ],
      relationships: [],
      fillable: [],
    })
    const reaction = 'task/entity/model.reaction'
    expect(derivePlanTasks(parsePlanDocument(document)).tasks.find((task) => task.id === reaction)!.dependsOn).toEqual([COMMENT])
    const { app, plan } = await approvedApp('cross-task', document, [SCAFFOLD, TESTS])

    const report = await planNextFile(plan, { appRoot: app, app: planAppState(POST_MOVED), now: NOW })

    expect(report.held.map((step) => step.id)).toEqual([DATA, HTTP])
    expect(report.waiting).toEqual([
      { id: `${COMMENT}/pages`, on: [DATA, HTTP] },
      { id: `${reaction}/scaffold`, on: [DATA, HTTP] },
      { id: `${reaction}/data`, on: [DATA, HTTP] },
    ])
    expect(report.step).toBeNull()
    const skipped = new Set([...report.held.map((step) => step.id), ...report.waiting.map((step) => step.id)])
    expect(report.verified.filter((id) => skipped.has(id))).toEqual([])
  })

  test('should block the steps naming a stale existing element, which no step owns, and name what the reference checks say now', async () => {
    const { app, plan } = await approvedApp('existing', threeTaskPlan())

    const report = await planNextFile(plan, { appRoot: app, app: planAppState({ actions: ['PostController.show'] }), now: NOW })

    expect(report.held).toHaveLength(1)
    const [held] = report.held
    expect(held!.id).toBe(POST_HTTP)
    expect(held!.stale).toEqual([
      expect.objectContaining({
        id: 'action.posts.index',
        change: 'existing',
        owned: false,
        through: ['route.posts.index'],
        within: [],
        checks: [expect.objectContaining({ key: 'plan:app-missing', status: 'fail' })],
      }),
    ])
    expect(report.waiting).toEqual([])
    expect(report.step!.id).toBe(`${COMMENT}/scaffold`)

    const text = formatPlanNext(report, 'comments.plan.json')
    expect(text).toContain(`Held, since what they depend on changed after the plan was approved:\n  ${POST_HTTP}\n    action.posts.index (actions, existing), named by route.posts.index: `)
    expect(text).toContain('      fail  The action "PostController.index" was not found in the project root')
    expect(text).toContain(`A held step is a person\u2019s decision: ${HELD_STEP_REMEDY}:\n  bunx guren plan:approve comments.plan.json`)
    expect(text).toContain('Commit the edited plan and its approvals file before the next plan:next')
    // Nothing reads a revision request yet: the advice does not name one as a way out.
    expect(text).not.toContain('run a revision')
  })

  test('should hand out a held step once the plan names what the application holds and that edit is approved and committed', async () => {
    // Another commit removed PostController.index; the route the plan alters now serves `show`.
    const document = threeTaskPlan() as { questions: unknown[]; controllers: Array<{ id: string; actions: Array<{ name: string }> }> }
    document.questions = []
    const { app, plan } = await approvedApp('released', document)
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'init')
    const moved = planAppState({ actions: ['PostController.show'] })
    expect((await planNextFile(plan, { appRoot: app, app: moved, now: NOW })).held.map((step) => step.id)).toEqual([POST_HTTP])

    const edited = JSON.parse(await readFile(plan, 'utf8')) as typeof document
    edited.controllers.find((controller) => controller.id === 'controller.posts')!.actions[0]!.name = 'show'
    await writeFile(plan, JSON.stringify(edited), 'utf8')
    await planApproveFile(plan, { app: moved, appRoot: app, now: NOW })

    // The edit and its approval are the person's commit, not the next step's.
    await expect(planNextFile(plan, { appRoot: app, app: moved, now: NOW })).rejects.toThrow('uncommitted changes')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'plan: posts.index serves show')

    const report = await planNextFile(plan, { appRoot: app, app: moved, now: NOW })
    expect(report.held).toEqual([])
    expect(report.step!.id).toBe(POST_HTTP)
  })

  test('should never block on an element whose freshness is unstamped or unjudged, nor on an application it could not read', async () => {
    const approvedUnread = approvedAgainst(loadCommentsPlan(), { models: { unreadable: 'models threw' } })
    const { app, plan } = await createApp('unjudged')
    await writeWorkspaceFiles(app, { 'comments.plan.json': JSON.stringify(approvedUnread) })
    await approvePlanFile(plan)

    // model.post has no stamp: a change to it is not evidence of anything.
    const unstamped = await planNextFile(plan, { appRoot: app, app: planAppState(POST_MOVED), now: NOW })
    expect(unstamped.held).toEqual([])
    expect(unstamped.step!.id).toBe(SCAFFOLD)

    const unjudged = await planNextFile(plan, { appRoot: app, app: planAppState({ tables: { unreadable: 'schema threw' } }), now: NOW })
    expect(unjudged.held).toEqual([])

    const threw = await planNextFile(plan, { appRoot: app, app: () => Promise.reject(new Error('routes file threw')), now: NOW })
    expect(threw.held).toEqual([])
    expect(threw.freshnessUnreadable).toBe('routes file threw')
    expect(formatPlanNext(threw, 'comments.plan.json')).toContain('The application could not be read, so no step was held: routes file threw\nOn a fresh clone, run `bunx guren codegen` first')
  })

  test('should report what the returned step depends on whose freshness is not judged, blocking nothing', async () => {
    const { app, plan } = await approvedApp('reported', loadCommentsPlan(), [SCAFFOLD, TESTS, DATA])

    const report = await planNextFile(plan, { appRoot: app, app: planAppState(), now: NOW })

    expect(report.step!.id).toBe(HTTP)
    // Validators are never read, so the one the step owns is always unjudged.
    expect(report.step!.unconfirmed).toEqual([expect.objectContaining({ id: 'validator.comment', verdict: 'unjudged', owned: true })])
    expect(formatPlanNext(report, 'comments.plan.json')).toContain('Depends on elements whose freshness is not confirmed, which holds nothing:\n  unjudged  validator.comment: ')
  })

  test('should not hold the marked step on what it owns, which is its own work in progress', async () => {
    const { app, plan } = await approvedApp('in-progress', loadCommentsPlan(), [SCAFFOLD, TESTS])
    // The class written before its table: neither the stamp nor what the plan leaves.
    const half: PlanAppStateInput = { models: ['Comment', 'Post', 'User'] }

    const unmarked = await planNextFile(plan, { appRoot: app, app: planAppState(half), now: NOW })
    expect(unmarked.held.map((step) => step.id)).toEqual([DATA, HTTP])

    await writeState(app, { ...(await readState(app)), active: { plan: 'comments.plan.json', step: DATA, startedAt: '2026-09-21T09:00:00.000Z', continuations: 1 } })
    const marked = await planNextFile(plan, { appRoot: app, app: planAppState(half), now: NOW })
    expect(marked.held).toEqual([])
    expect(marked.step!.id).toBe(DATA)
    expect((await readState(app)).active!.continuations).toBe(1)
  })

  test('should return a stalled step again on its own half-built work, with the stall reported', async () => {
    const { app, plan } = await approvedApp('stalled-half', loadCommentsPlan(), [SCAFFOLD, TESTS])
    const stall = { at: '2026-09-21T09:30:00.000Z', reason: `${MAX_CONTINUATIONS} continuations on this step`, output: 'x' }
    await writeState(app, { ...(await readState(app)), active: { plan: 'comments.plan.json', step: DATA, startedAt: '2026-09-21T09:00:00.000Z', continuations: 3, stalled: stall } })

    const report = await planNextFile(plan, { appRoot: app, app: planAppState({ models: ['Comment', 'Post', 'User'] }), now: NOW })

    expect(report.held).toEqual([])
    expect(report.step).toMatchObject({ id: DATA, stalled: stall })
    expect((await readState(app)).active).toMatchObject({ step: DATA, continuations: 0 })
    expect((await readState(app)).active!.stalled).toBeUndefined()
  })

  test('should hold the step owning an action whose controller went stale, through the containment link', async () => {
    const document = loadCommentsPlan() as Record<string, Array<Record<string, unknown>>>
    document.controllers!.push({
      id: 'controller.posts',
      change: { kind: 'existing' },
      className: 'PostController',
      actions: [{ id: 'action.posts.feed', change: { kind: 'add' }, name: 'feed', authorization: { middleware: [] }, response: { kind: 'json', description: 'the feed' }, rules: [] }],
    })
    const { app, plan } = await approvedApp('containment', document)

    const report = await planNextFile(plan, { appRoot: app, app: planAppState({ controllers: ['ArticleController'], actions: ['ArticleController.index', 'ArticleController.show'] }), now: NOW })

    const owner = report.held.find((step) => step.stale.some((element) => element.id === 'controller.posts'))
    expect(owner).toBeDefined()
    expect(owner!.stale.find((element) => element.id === 'controller.posts')).toMatchObject({ owned: false, through: [], within: ['action.posts.feed'] })
    expect(formatPlanNext(report, 'comments.plan.json')).toContain('controller.posts (controllers, existing), holding action.posts.feed: ')
  })

  test('should return no step when every step left is held or waits on one, keeping the stall of the marked one', async () => {
    const { app, plan } = await approvedApp('all-held', loadCommentsPlan(), [SCAFFOLD, TESTS])
    const stall = { at: '2026-09-21T09:30:00.000Z', reason: 'what the step depends on changed since the plan was approved', output: 'x' }
    await writeState(app, { ...(await readState(app)), active: { plan: 'comments.plan.json', step: HTTP, startedAt: '2026-09-21T09:00:00.000Z', continuations: 1, stalled: stall } })

    const report = await planNextFile(plan, { appRoot: app, app: planAppState(POST_MOVED), now: NOW })

    expect(report.step).toBeNull()
    expect(report.held.map((step) => step.id)).toEqual([DATA, HTTP])
    expect(report.held[1]!.stalled).toEqual(stall)
    expect(report.waiting.map((step) => step.id)).toEqual([`${COMMENT}/pages`])
    // The stall sticks until a plan:next returns its step, so the next run reports it again.
    expect((await readState(app)).active).toMatchObject({ step: HTTP, stalled: stall })
    expect((await planNextFile(plan, { appRoot: app, app: planAppState(POST_MOVED), now: NOW })).held[1]!.stalled).toEqual(stall)
    const text = formatPlanNext(report, 'comments.plan.json')
    expect(text).toContain('No step can be returned: every step left is held, or waits on one that is.')
    expect(text).not.toContain('Every step is verified')
    expect(text).toContain(`    stalled ${stall.at}: ${stall.reason}`)
  })

  test('should keep and report the stall of a marked step waiting behind a held one', async () => {
    const { app, plan } = await approvedApp('waiting-stall', loadCommentsPlan(), [SCAFFOLD, TESTS])
    const PAGES = `${COMMENT}/pages`
    const stall = { at: '2026-09-21T09:30:00.000Z', reason: `${MAX_CONTINUATIONS} continuations on this step`, output: 'x' }
    await writeState(app, { ...(await readState(app)), active: { plan: 'comments.plan.json', step: PAGES, startedAt: '2026-09-21T09:00:00.000Z', continuations: 3, stalled: stall } })

    const report = await planNextFile(plan, { appRoot: app, app: planAppState(POST_MOVED), now: NOW })

    expect(report.step).toBeNull()
    expect(report.waiting).toEqual([{ id: PAGES, on: [DATA, HTTP], stalled: stall }])
    expect((await readState(app)).active).toMatchObject({ step: PAGES, stalled: stall })
    expect(formatPlanNext(report, 'comments.plan.json')).toContain(`  ${PAGES} (on ${DATA}, ${HTTP})\n    stalled ${stall.at}: ${stall.reason}`)
  })

  test('should never read the application for a draft', async () => {
    const { app, plan } = await createApp('draft')
    let read = 0
    const report = await planNextFile(plan, { appRoot: app, app: () => (read++, Promise.resolve(planAppState(POST_MOVED) as PlanAppState)), now: NOW })
    expect(read).toBe(0)
    expect(report.held).toEqual([])
    expect(report.step!.id).toBe(SCAFFOLD)
  })

  describe('through the command, against an application on disk', () => {
    // Spied here rather than at collection, where the formatting block's restore would undo it.
    let log: ReturnType<typeof spyOn>
    beforeAll(() => {
      log = spyOn(console, 'log')
    })

    afterEach(() => {
      log.mockClear()
      process.exitCode = 0
    })

    afterAll(() => {
      log.mockRestore()
    })

    test('should skip the steps a commit after approval made stale, and exit 0', async () => {
      const app = join(ROOT, 'on-disk')
      await writeWorkspaceFiles(app, { ...PLAN_APP_FILES, 'comments.plan.json': JSON.stringify({ ...loadCommentsPlan(), questions: [] }) })
      git(app, 'init', '-q')
      git(app, 'add', '-A')
      git(app, 'commit', '-q', '-m', 'init')
      const plan = join(app, 'comments.plan.json')
      log.mockImplementation(() => {})
      await runCommand(builtinSubCommands['plan:approve'] as CommandDef, { rawArgs: [plan, '--app', app] })
      git(app, 'add', '-A')
      git(app, 'commit', '-q', '-m', 'approve')

      // Another commit renames the model the plan alters.
      await writeFile(join(app, 'app/Models/Post.ts'), (await readFile(join(app, 'app/Models/Post.ts'), 'utf8')).replace('class Post ', 'class Article '), 'utf8')
      git(app, 'commit', '-q', '-am', 'rename Post')
      log.mockClear()
      await runCommand(builtinSubCommands['plan:next'] as CommandDef, { rawArgs: [plan, '--app', app, '--json'] })
      const report = JSON.parse(String(log.mock.calls[0]![0])) as PlanNextReport

      expect(report.held.map((step) => step.id)).toEqual([DATA, HTTP])
      expect(report.held[0]!.stale[0]).toMatchObject({ id: 'model.post', owned: true, checks: [expect.objectContaining({ key: 'plan:app-missing' })] })
      expect(report.step!.id).toBe(SCAFFOLD)
      expect(process.exitCode ?? 0).toBe(0)
    })
  })
})
