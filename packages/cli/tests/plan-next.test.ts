import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { formatPlanNext, planNextFile, type PlanNextReport } from '../src/plan-next'
import { parsePlanDocument } from '../src/plan-render'
import { planDigest, PLAN_STATE_VERSION, type PlanState, type PlanStepRecord } from '../src/plan/state'
import { derivePlanTasks, planStepIds } from '../src/plan/tasks'
import { sha256 } from '../src/plan/verification'
import { writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan } from './plan-fixture'

// The command never loads the application, so an app here is a directory with a plan.
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
    expect(formatPlanNext(done, 'comments.plan.json')).toContain(`Every step is verified. Nothing is left to implement.\n${SCAFFOLD}: verified on the commands alone, nothing fingerprinted; plan:status shows what their elements are at.`)
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
    expect(formatPlanNext(report, 'comments.plan.json')).toContain('Every step is verified.')
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
    // The mark it wrote is a fresh one, so the next run is a plain step.
    expect((await planNextFile(plan, { appRoot: app, now: NOW })).step!.stalled).toBeUndefined()
  })

  test('should keep the mark of a step it returns again, continuations included', async () => {
    const active = { plan: 'comments.plan.json', step: SCAFFOLD, startedAt: '2026-09-20T00:00:00.000Z', continuations: 2, lastSignature: 'sig' }
    const { app, plan } = await createApp('resumed', { active })

    await planNextFile(plan, { appRoot: app, now: NOW })

    expect((await readState(app)).active).toEqual(active)
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
