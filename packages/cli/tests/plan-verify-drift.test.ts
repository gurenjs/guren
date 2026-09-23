import { beforeAll, describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { formatPlanNext, planNextFile } from '../src/plan-next'
import { parsePlanDocument } from '../src/plan-render'
import type { PlanVerifyReport } from '../src/plan-verify'
import { planDigest, writePlanStepRecord } from '../src/plan/state'
import { derivePlanTasks, planStepIds } from '../src/plan/tasks'
import { CLI_BIN_PATH, createTempRoot, writeWorkspaceFiles } from './helpers'
import { approvePlanFile, createPlanVerifyApp, DRIZZLE_KIT_STUB_FILES, loadApprovedCommentsPlan, PLAN_VERIFY_APP_FILES as APP, waiveForTest } from './plan-fixture'

let ROOT: string

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

const routes = readFileSync(new URL('../routes/web.ts', import.meta.url), 'utf8')

describe('comments', () => {
  test('[AC-comments-1] a signed-in user can comment on a post', () => {
    expect(routes).toContain("router.post('/posts/:postId/comments', [CommentController, 'store'])")
  })
  test('[AC-comments-2] an empty body is rejected', () => {
    expect(1).toBe(1)
  })
  test('[AC-comments-3] a guest is redirected', () => {
    expect(1).toBe(1)
  })
})
`

const DELETION_TESTS = `import { expect, test } from 'bun:test'

test('[AC-comments-4] the author can delete', () => {
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

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
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

function outcome(report: PlanVerifyReport, step: string): string | undefined {
  return report.steps.find((entry) => entry.stepId === step)?.record.outcome
}

/** The comment task's `http` step verified with what the deletion story will write waived, then the story's work written and committed. */
async function afterDeletionIsWritten(name: string, store: 'store' | 'destroy'): Promise<string> {
  const app = await createPlanVerifyApp(join(ROOT, name), {
    ...APP,
    ...DRIZZLE_KIT_STUB_FILES,
    '.gitignore': 'node_modules\n',
    'tests/comments.test.ts': COMMENT_TESTS,
    'comments.plan.json': JSON.stringify(splitPlan()),
  })
  await approvePlanFile(join(app, 'comments.plan.json'))
  await waiveForTest(join(app, 'comments.plan.json'), ['action.comments.destroy', 'resource.comment', 'policy.comment'])
  expect(outcome(verify(app, COMMENTS_HTTP), COMMENTS_HTTP)).toBe('verified')
  // Every other step done before, on nothing fingerprinted, so plan:next reads only the two under test.
  const plan = parsePlanDocument(splitPlan())
  for (const id of planStepIds(derivePlanTasks(plan)).filter((step) => step !== COMMENTS_HTTP && step !== DELETION_HTTP)) {
    await writePlanStepRecord(app, 'comments', id, {
      outcome: 'verified',
      planDigest: planDigest(plan),
      ranAt: '2026-09-23T00:00:00.000Z',
      durationMs: 1,
      commands: [],
      acceptance: [],
      incomplete: [],
      waived: [],
      fingerprint: { files: {}, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'h' } },
    })
  }

  await writeFile(join(app, 'routes/web.ts'), routesWithDestroy(store), 'utf8')
  await writeFile(join(app, 'app/Http/Controllers/CommentController.ts'), CONTROLLER_WITH_DESTROY, 'utf8')
  await writeWorkspaceFiles(app, { 'tests/deletion.test.ts': DELETION_TESTS })
  git(app, 'init', '-q')
  git(app, 'add', '-A')
  git(app, 'commit', '-q', '-m', 'the deletion story')
  return app
}

describe('plan:verify re-checks the steps a later step drifted', () => {
  beforeAll(async () => {
    ROOT = await createTempRoot('guren-plan-verify-drift-')
  })

  test('should re-verify an earlier step whose files the verified step wrote into, so plan:next moves past it', async () => {
    const app = await afterDeletionIsWritten('refreshed', 'store')

    const report = verify(app, DELETION_HTTP)

    expect(outcome(report, DELETION_HTTP)).toBe('verified')
    expect(report.reverified).toEqual([COMMENTS_HTTP])
    expect(outcome(report, COMMENTS_HTTP)).toBe('verified')
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

  test('should tell plan:next to re-check a drifted step rather than re-implement it', async () => {
    const app = await afterDeletionIsWritten('drifted', 'store')

    const next = await planNextFile(join(app, 'comments.plan.json'), { appRoot: app })

    expect(next.step?.id).toBe(COMMENTS_HTTP)
    expect(next.step?.drifted).toEqual(['app/Http/Controllers/CommentController.ts', 'routes/web.ts'])
    expect(formatPlanNext(next, 'comments.plan.json')).toContain(`Re-check it with \`bunx guren plan:verify comments.plan.json --step ${COMMENTS_HTTP}\` rather than re-implementing it`)
  }, 60_000)
})
