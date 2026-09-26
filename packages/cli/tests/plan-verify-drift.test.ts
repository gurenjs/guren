import { beforeAll, describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { formatPlanNext, planNextFile } from '../src/plan-next'
import { parsePlanDocument } from '../src/plan-render'
import type { PlanStatusReport } from '../src/plan-status'
import type { PlanVerifyReport } from '../src/plan-verify'
import { planDigest, writePlanStepRecord, type PlanStepRecord } from '../src/plan/state'
import { sha256 } from '../src/plan/verification'
import { derivePlanTasks, planStepIds } from '../src/plan/tasks'
import { CLI_BIN_PATH, createTempRoot, writeWorkspaceFiles } from './helpers'
import { approvePlanFile, createPlanVerifyApp, DRIZZLE_KIT_STUB_FILES, loadApprovedCommentsPlan, measured, PLAN_VERIFY_APP_FILES as APP, requestsRoute, TEST_APP_TYPE_IMPORT, waiveForTest } from './plan-fixture'

let ROOT: string

const COMMENTS_TESTS = 'task/entity/model.comment/tests'
const COMMENTS_HTTP = 'task/entity/model.comment/http'
const DELETION_HTTP = 'task/story/task.comment-deletion/http'

/**
 * The comments fixture split in two: the comment task stores a comment, and a story task (its
 * entity names no model) deletes one, whose route lands in the routes file and whose action in
 * the controller the comment task's `http` step verified. Neither route plans middleware or a
 * binding, which the fixture application does not write.
 */
function splitPlan(): Record<string, unknown> {
  const plan = loadApprovedCommentsPlan() as {
    routes: Array<{ id: string; middleware: string[]; bind: unknown[] }>
    tasks: Array<{ id: string; entity: string; summary: string; covers: string[]; acceptance: Array<{ id: string }> }>
  }
  for (const route of plan.routes) {
    route.middleware = []
    route.bind = []
  }
  const [comments] = plan.tasks
  const deleting = ['route.comments.destroy', 'policy.comment']
  const deletion = {
    id: 'task.comment-deletion',
    entity: 'Moderation',
    summary: 'Delete your own comment.',
    covers: deleting,
    acceptance: comments!.acceptance.filter((behaviour) => behaviour.id === 'AC-comments-4'),
  }
  comments!.covers = comments!.covers.filter((id) => !deleting.includes(id))
  comments!.acceptance = comments!.acceptance.filter((behaviour) => behaviour.id !== 'AC-comments-4')
  plan.tasks = [comments!, deletion]
  return plan as unknown as Record<string, unknown>
}

/** The store route's behaviour, as the comment task's tests see it: the route dispatches to `store`. */
const COMMENT_TESTS = `import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
${TEST_APP_TYPE_IMPORT}
const routes = readFileSync(new URL('../routes/web.ts', import.meta.url), 'utf8')

describe('comments', () => {
  test('[AC-comments-1] a signed-in user can comment on a post', () => {
    ${requestsRoute('AC-comments-1')}
    expect(routes).toContain("router.post('/posts/:postId/comments', [CommentController, 'store'])")
  })
  test('[AC-comments-2] an empty body is rejected', () => {
    ${requestsRoute('AC-comments-2')}
    expect(1).toBe(1)
  })
  test('[AC-comments-3] a guest is redirected', () => {
    ${requestsRoute('AC-comments-3')}
    expect(1).toBe(1)
  })
})
`

const DELETION_TESTS = `import { expect, test } from 'bun:test'
${TEST_APP_TYPE_IMPORT}
test('[AC-comments-4] the author can delete', () => {
  ${requestsRoute('AC-comments-4')}
  expect(1).toBe(1)
})
`

const CONTROLLER_WITH_DESTROY = `import { Controller } from '@guren/core'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'

export class CommentController extends Controller {
  async store() {
    await this.validateBody(CommentPayloadSchema)
    return this.redirect('/posts')
  }

  async destroy() {
    return this.redirect('/posts')
  }
}
`

function routesWithDestroy(store: 'store' | 'destroy'): string {
  return `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'
import { CommentController } from '../app/Http/Controllers/CommentController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.post('/posts/:postId/comments', [CommentController, '${store}']).name('comments.store')
  router.delete('/comments/:id', [CommentController, 'destroy']).name('comments.destroy')
}
`
}

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/**
 * `plan:verify` in a process of its own: Bun keeps the first routes file a process imports, and
 * the steps here rewrite it between runs.
 */
function verify(app: string, step: string): PlanVerifyReport {
  const result = Bun.spawnSync([process.execPath, CLI_BIN_PATH, 'plan:verify', join(app, 'comments.plan.json'), '--app', app, '--json', '--step', step], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  const stdout = result.stdout.toString()
  try {
    return JSON.parse(stdout) as PlanVerifyReport
  } catch {
    throw new Error(`plan:verify --step ${step} printed no report (exit ${result.exitCode}):\n${stdout}\n${result.stderr.toString()}`)
  }
}

function verifyAll(app: string): PlanVerifyReport {
  const result = Bun.spawnSync([process.execPath, CLI_BIN_PATH, 'plan:verify', join(app, 'comments.plan.json'), '--app', app, '--json'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
  return JSON.parse(result.stdout.toString()) as PlanVerifyReport
}

function doneRecord(files: Record<string, string> = {}, plan: Record<string, unknown> = splitPlan()): PlanStepRecord {
  return {
    outcome: 'verified',
    planDigest: planDigest(parsePlanDocument(plan)),
    ranAt: '2026-09-23T00:00:00.000Z',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    waived: [],
    fingerprint: { files, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'h' } },
  }
}

function outcome(report: PlanVerifyReport, step: string): string | undefined {
  return report.steps.find((entry) => entry.stepId === step)?.record.outcome
}

/** The split plan approved on `files`, and the comment task's `http` step verified with what the deletion story will write waived. */
async function withCommentsVerified(name: string, files: Record<string, string> = {}): Promise<string> {
  const app = await createPlanVerifyApp(join(ROOT, name), {
    ...APP,
    ...DRIZZLE_KIT_STUB_FILES,
    '.gitignore': 'node_modules\n',
    'tests/comments.test.ts': COMMENT_TESTS,
    'comments.plan.json': JSON.stringify(splitPlan()),
    ...files,
  })
  await approvePlanFile(join(app, 'comments.plan.json'))
  await waiveForTest(join(app, 'comments.plan.json'), ['action.comments.destroy', 'resource.comment', 'policy.comment'])
  expect(outcome(verify(app, COMMENTS_HTTP), COMMENTS_HTTP)).toBe('verified')
  return app
}

/** The comment task's `http` step verified, then the deletion story's work written and committed. */
async function afterDeletionIsWritten(name: string, store: 'store' | 'destroy'): Promise<string> {
  const app = await withCommentsVerified(name)
  // Every other step done before, on nothing fingerprinted, so plan:next reads only the two under test.
  for (const id of planStepIds(derivePlanTasks(parsePlanDocument(splitPlan()))).filter((step) => step !== COMMENTS_HTTP && step !== DELETION_HTTP)) {
    await writePlanStepRecord(app, 'comments', id, doneRecord())
  }

  await writeFile(join(app, 'routes/web.ts'), routesWithDestroy(store), 'utf8')
  await writeFile(join(app, 'app/Http/Controllers/CommentController.ts'), CONTROLLER_WITH_DESTROY, 'utf8')
  await writeWorkspaceFiles(app, { 'tests/deletion.test.ts': DELETION_TESTS })
  git(app, 'init', '-q')
  git(app, 'add', '-A')
  git(app, 'commit', '-q', '-m', 'the deletion story')
  return app
}

beforeAll(async () => {
  ROOT = await createTempRoot('guren-plan-verify-drift-')
})

describe('plan:verify re-checks the steps a later step drifted', () => {
  test('should re-verify an earlier step whose files the verified step wrote into, so plan:next moves past it', async () => {
    const app = await afterDeletionIsWritten('refreshed', 'store')

    const report = verify(app, DELETION_HTTP)

    expect(outcome(report, DELETION_HTTP)).toBe('verified')
    expect(report.reverified).toEqual([COMMENTS_HTTP])
    expect(outcome(report, COMMENTS_HTTP)).toBe('verified')
    // The step itself runs first: an earlier one is re-checked only once nothing it shares has failed.
    expect(report.steps.map((step) => step.stepId)).toEqual([DELETION_HTTP, COMMENTS_HTTP])
    const next = await planNextFile(join(app, 'comments.plan.json'), { appRoot: app })
    expect(next.verified).toEqual(expect.arrayContaining([COMMENTS_HTTP, DELETION_HTTP]))
    expect(next.step).toBeNull()
  }, 60_000)

  test('should record an earlier step failed when the later step broke it, and plan:next returns it to fix', async () => {
    const app = await afterDeletionIsWritten('broken', 'destroy')

    const report = verify(app, DELETION_HTTP)

    expect(report.reverified).toEqual([COMMENTS_HTTP])
    expect(outcome(report, COMMENTS_HTTP)).toBe('failed')
    const state = JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, { outcome: string }> }
    expect(state.steps[COMMENTS_HTTP]!.outcome).toBe('failed')
    const next = await planNextFile(join(app, 'comments.plan.json'), { appRoot: app })
    expect(next.step?.id).toBe(COMMENTS_HTTP)
    expect(next.step?.drifted).toBeUndefined()
  }, 60_000)

  test('should leave a drifted step verified while the step being verified fails a command they share, and re-check it once that step verifies', async () => {
    const app = await afterDeletionIsWritten('shared-failure', 'store')
    const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    await writeFile(join(app, 'package.json'), JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, codegen: 'echo "error: half-written" && exit 1' } }), 'utf8')

    const failing = verify(app, DELETION_HTTP)

    expect(outcome(failing, DELETION_HTTP)).toBe('failed')
    expect(failing.reverified).toEqual([])
    expect(failing.recheckPending).toEqual([COMMENTS_HTTP])
    const kept = JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, { outcome: string }> }
    expect(kept.steps[COMMENTS_HTTP]!.outcome).toBe('verified')

    await writeFile(join(app, 'package.json'), JSON.stringify(manifest), 'utf8')
    const passing = verify(app, DELETION_HTTP)

    expect(outcome(passing, DELETION_HTTP)).toBe('verified')
    expect(passing.reverified).toEqual([COMMENTS_HTTP])
  }, 60_000)

  test('should re-check a drifted tests:fail step without a run, verified while each behaviour keeps a test case', async () => {
    const app = await afterDeletionIsWritten('tests-step', 'store')
    await writePlanStepRecord(app, 'comments', COMMENTS_TESTS, doneRecord({ 'tests/comments.test.ts': sha256(COMMENT_TESTS) }))
    await writeFile(join(app, 'tests/comments.test.ts'), `${COMMENT_TESTS}\n// the http step's helper\n`, 'utf8')

    const kept = verify(app, COMMENTS_TESTS)

    expect(outcome(kept, COMMENTS_TESTS)).toBe('verified')
    expect(kept.steps[0]!.record.commands).toEqual([expect.objectContaining({ command: 'tests:fail', status: 'pass', label: 'not run: a re-check that one test file still carries each behaviour' })])

    await writePlanStepRecord(app, 'comments', COMMENTS_TESTS, doneRecord({ 'tests/comments.test.ts': sha256(COMMENT_TESTS) }))
    await writeFile(join(app, 'tests/comments.test.ts'), COMMENT_TESTS.replace('[AC-comments-2] ', ''), 'utf8')
    const lost = verify(app, COMMENTS_TESTS)

    // Reported, and left drifted rather than recorded: a recorded failure would send the next run to `tests:fail`, which cannot pass now.
    expect(outcome(lost, COMMENTS_TESTS)).toBe('failed')
    expect(lost.steps[0]!.record.commands[0]!.findings).toEqual(['[AC-comments-2] is carried by no test file'])
    expect(lost.recheckPending).toEqual([COMMENTS_TESTS])
    expect((JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, { outcome: string }> }).steps[COMMENTS_TESTS]!.outcome).toBe('verified')

    await writeFile(join(app, 'tests/comments.test.ts'), `${COMMENT_TESTS}\n// restored\n`, 'utf8')
    const restored = verify(app, COMMENTS_TESTS)

    expect(outcome(restored, COMMENTS_TESTS)).toBe('verified')
    expect(restored.reverified).toEqual([COMMENTS_TESTS])
  }, 60_000)

  test('should re-check every drifted step in a whole-plan run and name them', async () => {
    const app = await afterDeletionIsWritten('whole-plan', 'store')

    const report = verifyAll(app)

    expect(report.reverified).toEqual([COMMENTS_HTTP])
    expect(outcome(report, COMMENTS_HTTP)).toBe('verified')
    expect(outcome(report, DELETION_HTTP)).toBe('verified')
    // The steps that did not drift run first, whatever their task order.
    expect(report.steps.map((step) => step.stepId)).toEqual([DELETION_HTTP, COMMENTS_HTTP])
  }, 60_000)

  test('should leave drifted steps verified in a whole-plan run while another step fails a command they share', async () => {
    const app = await afterDeletionIsWritten('whole-plan-failure', 'store')
    const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    await writeFile(join(app, 'package.json'), JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, codegen: 'echo "error: half-written" && exit 1' } }), 'utf8')

    const report = verifyAll(app)

    expect(outcome(report, DELETION_HTTP)).toBe('failed')
    expect(report.reverified).toEqual([])
    expect(report.recheckPending).toEqual([COMMENTS_HTTP])
    const state = JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, { outcome: string }> }
    expect(state.steps[COMMENTS_HTTP]!.outcome).toBe('verified')
  }, 60_000)

  test('should stop re-checking at the first drifted step that fails, leaving the rest verified for a later run', async () => {
    const app = await afterDeletionIsWritten('every-step-drifted', 'store')
    await writePlanStepRecord(app, 'comments', DELETION_HTTP, doneRecord({ 'routes/web.ts': sha256('the routes before') }))
    const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    await writeFile(join(app, 'package.json'), JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, codegen: 'echo "error: half-written" && exit 1' } }), 'utf8')

    const report = verifyAll(app)

    expect(report.steps.map((step) => step.stepId)).toEqual([COMMENTS_HTTP])
    expect(outcome(report, COMMENTS_HTTP)).toBe('failed')
    expect(report.recheckPending).toEqual([DELETION_HTTP])
    const state = JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, { outcome: string }> }
    expect(state.steps[DELETION_HTTP]!.outcome).toBe('verified')
  }, 60_000)

  test('should go on re-checking past a failed static re-check, which runs nothing another step shares', async () => {
    const app = await afterDeletionIsWritten('static-then-data', 'store')
    const DATA = 'task/entity/model.comment/data'
    await writePlanStepRecord(app, 'comments', COMMENTS_TESTS, doneRecord({ 'tests/comments.test.ts': sha256(COMMENT_TESTS) }))
    await writePlanStepRecord(app, 'comments', DATA, doneRecord({ 'db/schema.ts': sha256('the schema before') }))
    await writeFile(join(app, 'tests/comments.test.ts'), COMMENT_TESTS.replace('[AC-comments-2] ', ''), 'utf8')

    const report = verifyAll(app)

    expect(outcome(report, COMMENTS_TESTS)).toBe('failed')
    expect(report.recheckPending).toContain(COMMENTS_TESTS)
    expect(report.reverified).toContain(DATA)
    const state = JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, { outcome: string }> }
    expect(state.steps[COMMENTS_TESTS]!.outcome).toBe('verified')
  }, 60_000)

  test('should keep an earlier step drifted and verified when its re-check comes out blocked', async () => {
    const app = await afterDeletionIsWritten('recheck-blocked', 'store')
    const DATA = 'task/entity/model.comment/data'
    await writePlanStepRecord(app, 'comments', DATA, doneRecord({ 'db/schema.ts': sha256('the schema before') }))
    await writeFile(join(app, 'node_modules/drizzle-kit/bin.cjs'), "console.log(JSON.stringify({ status: 'error', error: { code: 'internal_error' } }))\nprocess.exit(1)\n", 'utf8')

    const report = verify(app, DELETION_HTTP)

    expect(outcome(report, DELETION_HTTP)).toBe('verified')
    expect(outcome(report, DATA)).toBe('blocked')
    // The re-checks stop at the first that does not verify, so the comment step waits beside it.
    expect(report.recheckPending).toEqual([DATA, COMMENTS_HTTP])
    expect(report.reverified).toEqual([])
    const state = JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, { outcome: string }> }
    expect(state.steps[DATA]!.outcome).toBe('verified')
  }, 60_000)

  test('should tell plan:next to re-check a drifted step rather than re-implement it', async () => {
    const app = await afterDeletionIsWritten('drifted', 'store')

    const next = await planNextFile(join(app, 'comments.plan.json'), { appRoot: app })

    expect(next.step?.id).toBe(COMMENTS_HTTP)
    expect(next.step?.drifted).toEqual(['app/Http/Controllers/CommentController.ts', 'routes/web.ts'])
    expect(formatPlanNext(next, 'comments.plan.json')).toContain(`Re-check it with \`bunx guren plan:verify comments.plan.json --step ${COMMENTS_HTTP}\` rather than re-implementing it`)
  }, 60_000)
})

function stepRecord(report: PlanVerifyReport, step: string): PlanStepRecord {
  return report.steps.find((entry) => entry.stepId === step)!.record
}

async function storedRecord(app: string, step: string): Promise<PlanStepRecord> {
  return (JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, PlanStepRecord> }).steps[step]!
}

describe('plan:verify records the files and lines a step’s work changed', () => {
  test('should measure the marked step from where plan:next marked it, over its commits and the work left uncommitted', async () => {
    const app = await withCommentsVerified('measured')
    for (const id of planStepIds(derivePlanTasks(parsePlanDocument(splitPlan()))).filter((step) => step !== COMMENTS_HTTP && step !== DELETION_HTTP)) {
      await writePlanStepRecord(app, 'comments', id, doneRecord())
    }
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'the comment task')
    const start = git(app, 'rev-parse', 'HEAD')
    expect((await planNextFile(join(app, 'comments.plan.json'), { appRoot: app })).step?.id).toBe(DELETION_HTTP)

    await writeFile(join(app, 'routes/web.ts'), routesWithDestroy('store'), 'utf8')
    git(app, 'commit', '-q', '-am', 'the deletion route')
    await writeFile(join(app, 'app/Http/Controllers/CommentController.ts'), CONTROLLER_WITH_DESTROY, 'utf8')
    git(app, 'commit', '-q', '-am', 'the deletion action')
    await writeWorkspaceFiles(app, { 'tests/deletion.test.ts': DELETION_TESTS })

    const report = verify(app, DELETION_HTTP)

    expect(outcome(report, DELETION_HTTP)).toBe('verified')
    const work = measured(stepRecord(report, DELETION_HTTP).work)
    expect(work).toMatchObject({ from: start, settled: true })
    expect(work.files.map((file) => file.path)).toEqual(['app/Http/Controllers/CommentController.ts', 'routes/web.ts', 'tests/deletion.test.ts'])
    expect(work.files[2]).toEqual({ path: 'tests/deletion.test.ts', added: 7, removed: 0 })
    expect(work.added).toBe(work.files.reduce((total, file) => total + (file.added ?? 0), 0))
    expect((await storedRecord(app, DELETION_HTTP)).work).toEqual(work)
    // Re-checked beside it, the comment step keeps what it carried: it was verified with no mark on it.
    expect(report.reverified).toEqual([COMMENTS_HTTP])
    expect(stepRecord(report, COMMENTS_HTTP).work).toEqual({ measured: false, reason: 'plan:next did not mark this step, so where its work started is not known', settled: true })

    const status = Bun.spawnSync([process.execPath, CLI_BIN_PATH, 'plan:status', join(app, 'comments.plan.json'), '--app', app, '--json'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
    expect((JSON.parse(status.stdout.toString()) as PlanStatusReport).verification?.work?.[DELETION_HTTP]).toEqual(work)
  }, 60_000)

  test('should keep the measurement the step first verified with through a failed re-check and its fix under a fresh mark', async () => {
    const app = await afterDeletionIsWritten('work-kept', 'destroy')
    const implemented = { measured: true as const, from: 'a'.repeat(40), files: [{ path: 'routes/web.ts', added: 30, removed: 2 }], added: 30, removed: 2, settled: true }
    await writePlanStepRecord(app, 'comments', COMMENTS_HTTP, { ...(await storedRecord(app, COMMENTS_HTTP)), work: implemented })
    const next = await planNextFile(join(app, 'comments.plan.json'), { appRoot: app })
    expect(next.step?.id).toBe(COMMENTS_HTTP)
    expect(next.step?.drifted).toBeDefined()

    const failing = verify(app, COMMENTS_HTTP)

    expect(failing.reverified).toEqual([COMMENTS_HTTP])
    expect(outcome(failing, COMMENTS_HTTP)).toBe('failed')
    expect((await storedRecord(app, COMMENTS_HTTP)).work).toEqual(implemented)

    // The fix is a one-line diff from the fresh mark, which is not the work that implemented the step.
    await writeFile(join(app, 'routes/web.ts'), routesWithDestroy('store'), 'utf8')
    const fixed = verify(app, COMMENTS_HTTP)

    expect(outcome(fixed, COMMENTS_HTTP)).toBe('verified')
    expect(stepRecord(fixed, COMMENTS_HTTP).work).toEqual(implemented)
    expect((await storedRecord(app, COMMENTS_HTTP)).work).toEqual(implemented)
  }, 60_000)
})

/** The entry registrar calling one in a routes file of its own, which declares the store route. */
const SPLIT_ROUTES = {
  'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'
import { registerCommentRoutes } from './comments.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
  registerCommentRoutes(router)
}
`,
  'routes/comments.ts': `import type { Router } from '@guren/core'
import { CommentController } from '../app/Http/Controllers/CommentController.js'

export function registerCommentRoutes(router: Router): void {
  router.post('/posts/:postId/comments', [CommentController, 'store']).name('comments.store')
}
`,
}

describe('plan:verify fingerprints every routes file an entry route may be declared in', () => {
  test('should turn a verified route drifted when the routes file its entry registrar calls changes', async () => {
    const app = await withCommentsVerified('split-routes', {
      ...SPLIT_ROUTES,
      'tests/comments.test.ts': COMMENT_TESTS.replace('../routes/web.ts', '../routes/comments.ts'),
    })
    const planPath = join(app, 'comments.plan.json')
    const state = JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, PlanStepRecord> }
    const record = state.steps[COMMENTS_HTTP]!
    expect(Object.keys(record.fingerprint.files)).toEqual(expect.arrayContaining(['routes/web.ts', 'routes/comments.ts']))
    for (const id of planStepIds(derivePlanTasks(parsePlanDocument(splitPlan()))).filter((step) => step !== COMMENTS_HTTP)) {
      await writePlanStepRecord(app, 'comments', id, doneRecord())
    }

    // Nothing the readers compare moves, so only the fingerprint can tell the route's file changed.
    await writeFile(join(app, 'routes/comments.ts'), `${SPLIT_ROUTES['routes/comments.ts']}\n// the moderation routes go here\n`, 'utf8')
    git(app, 'init', '-q')
    git(app, 'add', '-A')
    git(app, 'commit', '-q', '-m', 'the comment routes, touched')

    const status = Bun.spawnSync([process.execPath, CLI_BIN_PATH, 'plan:status', planPath, '--app', app, '--json'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
    const store = (JSON.parse(status.stdout.toString()) as PlanStatusReport).elements.find((element) => element.id === 'route.comments.store')!
    expect(store.state).toBe('drifted')
    expect(store.notes.join('\n')).toContain('changed since: routes/comments.ts')
    const next = await planNextFile(planPath, { appRoot: app })
    expect(next.step?.id).toBe(COMMENTS_HTTP)
    expect(next.step?.drifted).toEqual(['routes/comments.ts'])
  }, 60_000)
})

/** The split plan with the store route `existing`: no step owns the route the store action is wired through. */
function existingStoreRoutePlan(): Record<string, unknown> {
  const plan = splitPlan() as { routes: Array<{ id: string; change: { kind: string } }> }
  plan.routes.find((route) => route.id === 'route.comments.store')!.change = { kind: 'existing' }
  return plan as unknown as Record<string, unknown>
}

const COMMENTS_PAGES = 'task/entity/model.comment/pages'

/**
 * The plan approved on the fixture app, `edit` written after the approval, `step` verified with
 * `waived` accepted, and every other step done on nothing fingerprinted: plan:next then reads only `step`.
 */
async function verifiedAlone(name: string, step: string, waived: string[], edit: Record<string, string> = {}): Promise<string> {
  const plan = existingStoreRoutePlan()
  const app = await createPlanVerifyApp(join(ROOT, name), {
    ...APP,
    ...DRIZZLE_KIT_STUB_FILES,
    '.gitignore': 'node_modules\n',
    'tests/comments.test.ts': COMMENT_TESTS,
    'comments.plan.json': JSON.stringify(plan),
  })
  await approvePlanFile(join(app, 'comments.plan.json'))
  await writeWorkspaceFiles(app, edit)
  if (waived.length > 0) await waiveForTest(join(app, 'comments.plan.json'), waived)
  expect(outcome(verify(app, step), step)).toBe('verified')
  for (const id of planStepIds(derivePlanTasks(parsePlanDocument(plan))).filter((other) => other !== step)) {
    await writePlanStepRecord(app, 'comments', id, doneRecord({}, plan))
  }
  return app
}

/** `files` written and committed, then what plan:next hands out. */
async function nextAfter(app: string, files: Record<string, string>): Promise<Awaited<ReturnType<typeof planNextFile>>> {
  await writeWorkspaceFiles(app, files)
  git(app, 'init', '-q')
  git(app, 'add', '-A')
  git(app, 'commit', '-q', '-m', 'unwired')
  return planNextFile(join(app, 'comments.plan.json'), { appRoot: app })
}

async function fingerprinted(app: string, step: string): Promise<string[]> {
  const state = JSON.parse(await readFile(join(app, '.guren/plans/comments.state.json'), 'utf8')) as { steps: Record<string, PlanStepRecord> }
  return Object.keys(state.steps[step]!.fingerprint.files)
}

describe('plan:verify fingerprints the files an element\'s wired verdict rests on', () => {
  test('should hand an action\'s step out again when the route it is wired through, owned by no step, is rewired', async () => {
    const app = await verifiedAlone('action-rewired', COMMENTS_HTTP, ['action.comments.destroy', 'resource.comment', 'policy.comment'])
    expect(await fingerprinted(app, COMMENTS_HTTP)).toEqual(expect.arrayContaining(['routes/web.ts', 'src/app.ts']))

    const next = await nextAfter(app, { 'routes/web.ts': APP['routes/web.ts']!.replace("[CommentController, 'store']", "[PostController, 'show']") })

    expect(next.step?.id).toBe(COMMENTS_HTTP)
    expect(next.step?.drifted).toEqual(['routes/web.ts'])
  }, 60_000)

  test('should hand a validator\'s step out again when the action validating with it stops', async () => {
    const app = await verifiedAlone('validator-unused', COMMENTS_HTTP, ['controller.comments', 'action.comments.store', 'action.comments.destroy', 'resource.comment', 'policy.comment'])
    expect(await fingerprinted(app, COMMENTS_HTTP)).toEqual(expect.arrayContaining(['app/Http/Controllers/CommentController.ts', 'routes/web.ts']))

    const controller = APP['app/Http/Controllers/CommentController.ts']!
    const next = await nextAfter(app, { 'app/Http/Controllers/CommentController.ts': controller.replace('    await this.validateBody(CommentPayloadSchema)\n', '') })

    expect(next.step?.id).toBe(COMMENTS_HTTP)
    expect(next.step?.drifted).toEqual(['app/Http/Controllers/CommentController.ts'])
  }, 60_000)

  test('should hand a page\'s step out again when the action returning it stops', async () => {
    const posts = APP['app/Http/Controllers/PostController.ts']!
    const app = await verifiedAlone('page-unreturned', COMMENTS_PAGES, [], {
      'resources/js/pages/posts/Show.tsx': 'interface Props {\n  comments: unknown[]\n}\n\nexport default function Show(_props: Props) {\n  return null\n}\n',
      'app/Http/Controllers/PostController.ts': posts.replace('return this.json([])', "return this.inertia('posts/Show', { comments: [] })"),
    })
    expect(await fingerprinted(app, COMMENTS_PAGES)).toEqual(expect.arrayContaining(['app/Http/Controllers/PostController.ts', 'routes/web.ts']))

    const next = await nextAfter(app, { 'app/Http/Controllers/PostController.ts': posts })

    expect(next.step?.id).toBe(COMMENTS_PAGES)
    expect(next.step?.drifted).toEqual(['app/Http/Controllers/PostController.ts'])
  }, 60_000)
})
