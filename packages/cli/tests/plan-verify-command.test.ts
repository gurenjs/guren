import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { parsePlanDocument } from '../src/plan-render'
import type { PlanStatusReport } from '../src/plan-status'
import type { PlanVerifyReport } from '../src/plan-verify'
import { planDigest, PLAN_STATE_VERSION, type PlanStepRecord } from '../src/plan/state'
import { sha256 } from '../src/plan/verification'
import { linkWorkspaceCore, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan, PLAN_APP_FILES } from './plan-fixture'

// `bun test` fires no exit handler, so the roots earlier runs left are removed at the start.
// Each application has a directory of its own, since Bun keys an imported routes file on
// its path and a second test would read the first one's route graph back.
const ROOT_PREFIX = 'guren-plan-verify-command-'
let ROOT: string
const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')

const HTTP = 'task/entity/model.comment/http'
const DATA = 'task/entity/model.comment/data'

const SCHEMA = `${PLAN_APP_FILES['db/schema.ts']}
import { integer, timestamp } from 'drizzle-orm/pg-core'

export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body'),
  postId: integer('post_id').notNull().references(() => posts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
`

/** The comments half of the plan written far enough for its `http` step to run, with every script a no-op. */
const APP: Record<string, string> = {
  ...PLAN_APP_FILES,
  'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() {
    return this.json([])
  }
  async show() {
    return this.json({})
  }
}
`,
  '.guren/routes.gen.ts': 'export {}\n',
  '.guren/pages.gen.ts': 'export {}\n',
  '.guren/data.gen.ts': 'export {}\n',
  'package.json': JSON.stringify({ name: 'verify-app', type: 'module', scripts: { codegen: 'exit 0', typecheck: 'exit 0', 'db:migrate': 'exit 0' } }),
  'bunfig.toml': '[install]\nauto = "disable"\n',
  'db/schema.ts': SCHEMA,
  'app/Models/Comment.ts': `import { defineModel } from '@guren/core'
import { comments } from '@/db/schema'

export class Comment extends defineModel(comments, { fillable: ['body'] }) {}
`,
  'app/Http/Validators/CommentValidator.ts': 'export const CommentPayloadSchema = { safeParse: () => ({ success: true }) }\n',
  'app/Http/Controllers/CommentController.ts': `import { Controller } from '@guren/core'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'

export class CommentController extends Controller {
  async store() {
    await this.validateBody(CommentPayloadSchema)
    return this.redirect('/posts')
  }
}
`,
  'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'
import { CommentController } from '../app/Http/Controllers/CommentController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.post('/posts/:postId/comments', [CommentController, 'store']).name('comments.store')
}
`,
  'src/app.ts': `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web.js'

export default createApp({ routes: registerWebRoutes })
`,
  'tests/comments.test.ts': `import { describe, expect, test } from 'bun:test'

describe('comments', () => {
  test('[AC-comments-1] a signed-in user can comment on a post', () => {
    expect(1).toBe(1)
  })
  test('[AC-comments-2] a guest is redirected', () => {
    expect(1).toBe(1)
  })
  test('[AC-comments-3] an empty body is rejected', () => {
    expect(1).toBe(1)
  })
  test('[AC-comments-4] the author can delete', () => {
    expect(1).toBe(1)
  })
})
`,
}

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

    const state = JSON.parse(await readFile(join(app, '.guren/plans/http.state.json'), 'utf8')) as { stateVersion: number; steps: Record<string, PlanStepRecord> }
    expect(state.stateVersion).toBe(PLAN_STATE_VERSION)
    expect(state.steps[HTTP]).toMatchObject({ outcome: 'incomplete', planDigest: planDigest(parsePlanDocument(loadCommentsPlan())) })
    expect(await readFile(join(app, '.guren/plans/.gitignore'), 'utf8')).toBe('*.state.json\n')
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

    const revised = await writePlan('lift-revised.plan.json', { ...loadCommentsPlan(), title: 'Revised' })
    await writeFile(join(app, '.guren/plans/lift-revised.state.json'), JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: { [DATA]: record } }), 'utf8')
    const stale = await status(revised, app)
    expect(stale.verification).toEqual({ stateFile: '.guren/plans/lift-revised.state.json', staleSteps: [DATA] })
    expect(stale.summary.states.verified).toBe(0)
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
