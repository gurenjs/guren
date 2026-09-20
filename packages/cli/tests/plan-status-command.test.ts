import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runCommand } from 'citty'

import { builtinSubCommands } from '../src/commands'
import type { PlanStatusReport } from '../src/plan-status'
import { linkWorkspaceCore, writeWorkspaceFiles } from './helpers'
import { loadCommentsPlan, PLAN_APP_FILES } from './plan-fixture'

// `bun test` fires no exit handler, so the roots earlier runs left are removed at the start.
// Each application has a directory of its own, since Bun keys an imported routes file on
// its path and a second test would read the first one's route graph back.
const ROOT_PREFIX = 'guren-plan-status-command-'
let ROOT: string
const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')

const APP_ENTRY = `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web.js'

export default createApp({ routes: registerWebRoutes })
`

const WEB_ROUTES = `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
}
`

const BASE_APP: Record<string, string> = { ...PLAN_APP_FILES, 'src/app.ts': APP_ENTRY, 'routes/web.ts': WEB_ROUTES }

const COMMENTS_APP: Record<string, string> = {
  ...BASE_APP,
  'db/schema.ts': `${PLAN_APP_FILES['db/schema.ts']}
import { index, integer, timestamp } from 'drizzle-orm/pg-core'

export const comments = pgTable(
  'comments',
  {
    id: serial('id').primaryKey(),
    body: text('body'),
    postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('comments_post_idx').on(table.postId)],
)
`,
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
  'routes/comments.ts': `import type { Router } from '@guren/core'
import { CommentController } from '../app/Http/Controllers/CommentController.js'

export function registerCommentRoutes(router: Router): void {
  router.post('/posts/:postId/comments', [CommentController, 'store']).name('comments.store')
}
`,
  'routes/web.ts': `import type { Router } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController.js'
import { registerCommentRoutes } from './comments.js'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index']).name('posts.index')
  registerCommentRoutes(router)
}
`,
}

async function createApp(name: string, files: Record<string, string>): Promise<string> {
  const dir = join(ROOT, name)
  await writeWorkspaceFiles(dir, { ...files, 'bunfig.toml': '[install]\nauto = "disable"\n' })
  await linkWorkspaceCore(dir)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(WORKSPACE_DRIZZLE, join(dir, 'node_modules', 'drizzle-orm'), 'dir')
  return dir
}

async function writePlan(name: string, document: unknown = loadCommentsPlan()): Promise<string> {
  await writeWorkspaceFiles(ROOT, { [name]: typeof document === 'string' ? document : JSON.stringify(document) })
  return join(ROOT, name)
}

describe('plan:status', () => {
  const log = spyOn(console, 'log')

  beforeAll(async () => {
    const stale = (await readdir(tmpdir())).filter((name) => name.startsWith(ROOT_PREFIX))
    await Promise.all(stale.map((name) => rm(join(tmpdir(), name), { recursive: true, force: true })))
    ROOT = await mkdtemp(join(tmpdir(), ROOT_PREFIX))
  })

  afterEach(() => {
    log.mockClear()
  })

  afterAll(() => {
    log.mockRestore()
  })

  async function run(plan: string, app: string, ...flags: string[]): Promise<string> {
    log.mockImplementation(() => {})
    await runCommand(builtinSubCommands['plan:status'], { rawArgs: [plan, '--app', app, ...flags] })
    return log.mock.calls.map((call) => String(call[0])).join('\n')
  }

  async function report(plan: string, app: string): Promise<PlanStatusReport> {
    return JSON.parse(await run(plan, app, '--json')) as PlanStatusReport
  }

  function states(result: PlanStatusReport): Record<string, string> {
    return Object.fromEntries(result.elements.map((element) => [element.id, element.state]))
  }

  test('should report everything a plan adds as planned before any of it is written', async () => {
    const result = await report(await writePlan('before.plan.json'), await createApp('before', BASE_APP))

    const added = result.elements.filter((element) => element.change === 'add')
    expect(added.map((element) => element.state)).toEqual(added.map(() => 'planned'))
    expect(result.summary.existing).toEqual({ found: 1, missing: [], unread: [] })
  })

  test('should keep the JSON report to its documented shape', async () => {
    const result = await report(await writePlan('shape.plan.json'), await createApp('shape', BASE_APP))

    expect(Object.keys(result).sort()).toEqual(['elements', 'plan', 'reportVersion', 'summary'])
    expect(result.reportVersion).toBe(1)
    expect(result.plan).toEqual({ file: 'shape.plan.json', title: 'Comments on posts', hash: null })
    expect(Object.keys(result.elements[0]!).sort()).toEqual(['change', 'id', 'label', 'notes', 'properties', 'section', 'state'])
    expect(Object.keys(result.summary).sort()).toEqual(['existing', 'notCheckable', 'properties', 'states'])
  })

  test('should read the written half of a plan from the routes, the schema and the sources', async () => {
    const result = await report(await writePlan('after.plan.json'), await createApp('after', COMMENTS_APP))

    expect(states(result)).toMatchObject({
      'model.comment': 'drifted',
      'column.comment.id': 'present',
      'column.comment.body': 'drifted',
      'column.comment.postId': 'present',
      'column.comment.createdAt': 'present',
      'validator.comment': 'wired',
      'controller.comments': 'present',
      'action.comments.store': 'wired',
      'action.comments.destroy': 'planned',
      'route.comments.store': 'drifted',
      'route.comments.destroy': 'planned',
      'resource.comment': 'planned',
    })
    const body = result.elements.find((element) => element.id === 'column.comment.body')!
    expect(body.properties.filter((property) => property.verdict === 'differ').map((property) => property.property)).toEqual(['nullable'])
    const route = result.elements.find((element) => element.id === 'route.comments.store')!
    expect(route.properties.filter((property) => property.verdict === 'differ').map((property) => property.property)).toEqual(['middleware auth', 'bind postId'])
  })

  test('should read an index and a default the static reader cannot, through the runtime schema', async () => {
    const result = await report(await writePlan('runtime.plan.json'), await createApp('runtime', COMMENTS_APP))

    const postId = result.elements.find((element) => element.id === 'column.comment.postId')!
    expect(postId.properties.find((property) => property.property === 'index')).toMatchObject({ verdict: 'match' })
    expect(result.summary.notCheckable).toContainEqual({ id: 'column.comment.postId', properties: ['references.onDelete'] })
  })

  test('should never call a route wired when createApp() is not handed its registrar', async () => {
    const app = await createApp('unmounted', { ...COMMENTS_APP, 'src/app.ts': "import { createApp } from '@guren/core'\n\nexport default createApp({})\n" })

    const result = await report(await writePlan('unmounted.plan.json'), app)

    expect(states(result)['action.comments.store']).toBe('present')
    expect(states(result)['validator.comment']).toBe('present')
    expect(Object.values(states(result))).not.toContain('wired')
    expect(result.elements.find((element) => element.id === 'action.comments.store')!.notes).toEqual([expect.stringContaining('passes no routes')])
  })

  test('should fall back to the static schema when the schema throws at import, and block what that cannot prove', async () => {
    const schema = `${PLAN_APP_FILES['db/schema.ts']}
const shared = { body: text('body').notNull() }
export const comments = pgTable('comments', { id: serial('id').primaryKey(), ...shared })

throw new Error('DATABASE_URL is not set')
`
    const result = await report(await writePlan('throws.plan.json'), await createApp('throws', { ...BASE_APP, 'db/schema.ts': schema }))

    expect(states(result)['column.comment.id']).toBe('present')
    const postId = result.elements.find((element) => element.id === 'column.comment.postId')!
    expect(postId).toMatchObject({ state: 'blocked', reason: expect.stringContaining('DATABASE_URL is not set') })
  })

  test('should print a table grouped by section, the counts and the not checkable list', async () => {
    const output = await run(await writePlan('human.plan.json'), await createApp('human', COMMENTS_APP))

    expect(output).toContain('Routes\n')
    expect(output).toMatch(/drifted\s+add\s+comments\.store\s+route\.comments\.store/)
    expect(output).toContain('differs: middleware auth (planned applied, found not applied)')
    expect(output).toMatch(/planned \d+, present \d+, wired \d+, drifted \d+, unjudged \d+, blocked \d+/)
    expect(output).toContain('Planned, not checkable:')
  })

  test('should fail only when the plan cannot be read', async () => {
    const app = await createApp('unreadable-plan', BASE_APP)

    await expect(run(join(ROOT, 'missing.plan.json'), app)).rejects.toThrow('Cannot read the plan')
    await expect(run(await writePlan('broken.plan.json', '{'), app)).rejects.toThrow('not valid JSON')
    await expect(run(await writePlan('invalid.plan.json', { planVersion: 1 }), app)).rejects.toThrow('does not match the plan schema')
  })
})
