import { readFileSync } from 'node:fs'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { z } from 'zod'

import { parsePlanDocument } from '../src/plan-render'
import { planWaiveFile } from '../src/plan-waive'
import type {
  PlanAppName,
  PlanAppNames,
  PlanAppScope,
  PlanAppState,
  PlanAppTable,
  PlanAppUnreadable,
} from '../src/plan/app-state'
import { readPlanApprovals, recordPlanApproval, requireReadableApprovals } from '../src/plan/approvals'
import { stampContextHash } from '../src/plan/freshness'
import { planHash } from '../src/plan/identity'
import { hasBaseline } from '../src/plan/render'
import { PLAN_STATE_VERSION, type PlanActiveStep } from '../src/plan/state'
import { PlanSchema, type Plan, type PlanDraft, type PlanDraftSchema } from '../src/plan/schema'
import type { PlanPagePayload } from '../src/plan/render'
import { FOUNDATION_TASK_ID, type PlanTaskDerivation } from '../src/plan/tasks'
import { linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

export const TEST_BASELINE = { rev: '6445bc71', contextHash: { 'model.post': 'ab12' } }

/** A fresh object per call, so a test may mutate what it gets. */
export function loadCommentsPlan(): Record<string, unknown> {
  const text = readFileSync(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), 'utf8')
  return JSON.parse(text) as Record<string, unknown>
}

/** The fixture as an approved plan *document*: what a command reads off disk and parses itself. */
export function loadApprovedCommentsPlan(): Record<string, unknown> {
  return { ...loadCommentsPlan(), baseline: TEST_BASELINE }
}

/** What a plan *document* spells, before parsing fills the defaults in. */
export type PlanInput = z.input<typeof PlanDraftSchema>

/** The comments fixture typed as a document, for a test that edits it section by section. */
export function loadCommentsPlanInput(): PlanInput {
  return loadCommentsPlan() as unknown as PlanInput
}

/** The fixture as a plan with an identity: parsed, under {@link TEST_BASELINE}. */
export function loadParsedCommentsPlan(): Plan {
  return PlanSchema.parse(loadApprovedCommentsPlan())
}

/** The document stamped against `at` the way `plan:approve` stamps it: nothing is stale against `at` itself. */
export function approvedAgainst(document: Record<string, unknown>, at: PlanAppStateInput = {}): Record<string, unknown> {
  return { ...document, baseline: { rev: 'abc123', contextHash: stampContextHash(parsePlanDocument(document), planAppState(at)).contextHash } }
}

/**
 * Records an approval of the plan file's current hash beside it through the writer `plan:approve`
 * uses, keeping the approvals already there. For a test whose subject is not approval itself.
 */
export async function approvePlanFile(planPath: string): Promise<string> {
  const hash = planHash(PlanSchema.parse(JSON.parse(await readFile(planPath, 'utf8'))))
  const approvals = requireReadableApprovals(await readPlanApprovals(planPath))
  await recordPlanApproval(planPath, approvals, { hash, approvedAt: '2026-09-22T09:00:00.000Z', approvedBy: 'Ada <ada@example.com>' })
  return hash
}

/** {@link approvePlanFile} where `document`, the plan file's content, carries a baseline; a draft is left as it is. */
export async function approveIfStamped(planPath: string, document: unknown): Promise<void> {
  if (hasBaseline(document)) await approvePlanFile(planPath)
}

/** A section as a test spells it: a bare name sits at the project root. */
type NameInput = Array<string | PlanAppName> | PlanAppUnreadable
type TableEntry = Omit<PlanAppTable, 'module'> & { module?: PlanAppScope }
type TableInput = TableEntry[] | PlanAppUnreadable

/** The tables {@link planAppState} declares, for a test that moves one to another app root. */
export const PLAN_APP_TABLES: TableEntry[] = [
  { identifier: 'posts', tableName: 'posts', columns: ['id', 'title', 'body'] },
  { identifier: 'users', tableName: 'users', columns: ['id', 'email'] },
]

type ScopedSection = 'models' | 'controllers' | 'actions' | 'resources' | 'policies' | 'pages' | 'validators'

export type PlanAppStateInput = Omit<Partial<PlanAppState>, ScopedSection | 'tables'> &
  Partial<Record<ScopedSection, NameInput>> & { tables?: TableInput }

function names(input: NameInput): PlanAppNames {
  return Array.isArray(input) ? input.map((entry) => (typeof entry === 'string' ? { name: entry, module: null } : entry)) : input
}

function tables(input: TableInput): PlanAppState['tables'] {
  return Array.isArray(input) ? input.map((table) => ({ module: null, ...table })) : input
}

/** An application the comments fixture is a clean delta against. */
export function planAppState(overrides: PlanAppStateInput = {}): PlanAppState {
  const { models, controllers, actions, resources, policies, pages, validators, tables: tableInput, ...rest } = overrides
  return {
    models: names(models ?? ['Post', 'User']),
    controllers: names(controllers ?? ['PostController']),
    actions: names(actions ?? ['PostController.index', 'PostController.show']),
    resources: names(resources ?? ['PostResource']),
    policies: names(policies ?? ['PostPolicy']),
    pages: names(pages ?? ['posts/Index', 'posts/Show']),
    validators: names(validators ?? { unreadable: 'validators are named by exported symbol' }),
    routes: [
      { name: 'posts.index', method: 'GET', path: '/posts' },
      { name: 'posts.show', method: 'GET', path: '/posts/:id' },
    ],
    tables: tables(tableInput ?? PLAN_APP_TABLES),
    apiOnly: false,
    ...rest,
  }
}

/**
 * The same application on disk, for the tests that go through the command and its
 * scanners. It does not derive from {@link planAppState}; the command test asserting
 * the fixture's three warnings is what holds the two together.
 * It declares no routes file, so the route section reads as an application with no
 * routes rather than as one nobody could read, which would be a second warning.
 */
export const PLAN_APP_FILES: Record<string, string> = {
  'app/Models/Post.ts': `import { defineModel } from '@guren/core'
import { posts } from '@/db/schema'

export class Post extends defineModel(posts) {}
`,
  'app/Models/User.ts': `import { defineModel } from '@guren/core'
import { users } from '@/db/schema'

export class User extends defineModel(users) {}
`,
  'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() {}
  async show() {}
}
`,
  'app/Http/Resources/PostResource.ts': 'export class PostResource {}\n',
  'app/Policies/PostPolicy.ts': 'export class PostPolicy {}\n',
  'resources/js/pages/posts/Index.tsx': 'export default function Index() {\n  return null\n}\n',
  'resources/js/pages/posts/Show.tsx': 'export default function Show() {\n  return null\n}\n',
  'db/schema.ts': `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
})

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
})
`,
}

/**
 * A second application, which already has the Comment the plan adds. Two applications
 * that both declare something is what tells a flag the command read from one it
 * ignored; a root that does not exist would answer for whatever "no such directory"
 * is taken to mean.
 */
export const PLAN_APP_WITH_COMMENTS: Record<string, string> = {
  ...PLAN_APP_FILES,
  'app/Models/Comment.ts': `import { defineModel } from '@guren/core'
import { comments } from '@/db/schema'

export class Comment extends defineModel(comments) {}
`,
}

/**
 * The page's data block, taken out of the rendered document the way a consumer
 * would. Asserting on this string rather than on the whole file is what lets the
 * escaping tests fail: the document's own script and style are full of `<` and `&`.
 */
export function planDataBlock(html: string): string {
  const opening = '<script type="application/json" id="plan-data">'
  const start = html.indexOf(opening)
  if (start < 0) throw new Error('the rendered page carries no data block')
  const end = html.indexOf('</script>', start)
  if (end < start) throw new Error('the rendered page leaves its data block open')
  return html.slice(start + opening.length, end)
}

/** The page's data block, parsed back: what the page will actually read. */
export function planPageData(html: string): PlanPagePayload {
  return JSON.parse(planDataBlock(html)) as PlanPagePayload
}

/** What each element needs, read from the plan independently of the module under test. */
function planReferences(plan: PlanDraft): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (from: string, ...targets: Array<string | undefined>): void => {
    out.set(from, [...(out.get(from) ?? []), ...targets.filter((target) => target !== undefined)])
  }
  for (const entry of plan.resources) add(entry.id, entry.model)
  for (const entry of plan.policies) add(entry.id, entry.model)
  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      // An existing action is nobody's work, so what it reads is nobody's obligation.
      if (action.change.kind === 'existing') continue
      const response = action.response
      add(controller.id, action.body, action.params, action.query, action.authorization.policy?.id)
      add(controller.id, response.kind === 'inertia' ? response.view : undefined, response.kind === 'resource' ? response.resource : undefined)
      add(action.id, ...(out.get(controller.id) ?? []))
    }
  }
  for (const route of plan.routes) add(route.id, route.action, ...route.bind.map((bind) => bind.model))
  for (const entry of plan.views) {
    add(entry.id, entry.form?.validator, entry.form?.submitsTo, ...entry.actions.map((action) => action.route), ...entry.props.map((prop) => prop.resource))
  }
  return out
}

/**
 * Where Foundation fails to stand alone: it waits for nothing, so an element it owns
 * that needs another task's work is an order the derivation dropped. A
 * `foundation-reference` note excuses the targets it names, under the element it names,
 * and nothing else. Empty is the property; a string names the pair that breaks it.
 * It returns them rather than asserting, so a sweep over generated plans reads it too.
 */
export function foundationViolations(plan: PlanDraft, result: PlanTaskDerivation): string[] {
  const foundation = result.tasks.find((task) => task.id === FOUNDATION_TASK_ID)
  if (!foundation) return []

  const violations: string[] = []
  if (foundation.dependsOn.length > 0) violations.push(`${FOUNDATION_TASK_ID} waits for "${foundation.dependsOn.join('", "')}"`)
  if (result.tasks[0]?.id !== FOUNDATION_TASK_ID) violations.push(`${FOUNDATION_TASK_ID} is not the first task`)

  const elsewhere = new Set(
    result.tasks.filter((task) => task !== foundation).flatMap((task) => task.steps.flatMap((step) => step.elementIds)),
  )
  const excused = new Map(
    result.notes
      .filter((note) => note.kind === 'foundation-reference')
      .map((note) => [note.ids[0], new Set(note.ids.slice(1))]),
  )
  // An action shares its controller's fate, so the exception is reported on the controller.
  const controllerOf = new Map(
    plan.controllers.flatMap((controller) => controller.actions.map((action) => [action.id, controller.id] as const)),
  )
  const references = planReferences(plan)
  for (const id of foundation.steps.flatMap((step) => step.elementIds)) {
    const allowed = excused.get(controllerOf.get(id) ?? id)
    for (const target of references.get(id) ?? []) {
      if (elsewhere.has(target) && allowed?.has(target) !== true) violations.push(`"${id}" needs "${target}"`)
    }
  }
  return violations
}

/** Strings a plan may carry in any free-text field; every one must come out as text. */
export const PAYLOADS = [
  '</script><script>alert(1)</script>',
  '<!--',
  '<img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  'line\u2028separator\u2029paragraph',
  'dollars: $` and $& and $\' and $0',
  ']]>',
  '&lt;&amp;&gt;',
]

export const PLAN_VERIFY_SCHEMA = `${PLAN_APP_FILES['db/schema.ts']}
import { integer, timestamp } from 'drizzle-orm/pg-core'

export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body'),
  postId: integer('post_id').notNull().references(() => posts.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
`

/**
 * The comments half of the plan written far enough for its `http` step to run, with every
 * script a no-op: the `plan:verify` command and the Stop hook tests run the real `bun test` on it.
 */
export const PLAN_VERIFY_APP_FILES: Record<string, string> = {
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
  'db/schema.ts': PLAN_VERIFY_SCHEMA,
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

/**
 * A drizzle-kit that answers every schema as covered by its migrations, and the config it is
 * asked with: what a data step's `db:migrate` asks before it runs.
 */
export const DRIZZLE_KIT_STUB_FILES: Record<string, string> = {
  'drizzle.config.ts': "export default { schema: './db/schema.ts', out: './db/migrations', dialect: 'postgresql' }\n",
  'node_modules/drizzle-kit/package.json': JSON.stringify({ name: 'drizzle-kit', bin: { 'drizzle-kit': 'bin.cjs' } }),
  'node_modules/drizzle-kit/bin.cjs': "console.log(JSON.stringify({ status: 'no_changes', dialect: 'postgresql' }))\n",
}

/** The step of the comments fixture that {@link PLAN_VERIFY_APP_FILES} leaves incomplete. */
export const HTTP_STEP = 'task/entity/model.comment/http'

/**
 * {@link PLAN_VERIFY_APP_FILES} on disk at `dir`, resolvable like an install, with the comments
 * plan beside it and, when given, a step marked for the Stop hook. `node_modules` is ignored so
 * a committed copy reads as a clean tree.
 */
export async function writePlanVerifyApp(dir: string, active?: PlanActiveStep): Promise<void> {
  await createPlanVerifyApp(dir, {
    ...PLAN_VERIFY_APP_FILES,
    '.gitignore': 'node_modules\n',
    'comments.plan.json': JSON.stringify(loadCommentsPlan()),
    ...(active ? { '.guren/plans/.gitignore': '*.state.json\n.gitignore\n', '.guren/plans/comments.state.json': JSON.stringify({ stateVersion: PLAN_STATE_VERSION, steps: {}, active }) } : {}),
  })
}

/** `files` on disk at `dir`, resolvable like an install: `@guren/core` linked, `drizzle-orm` the workspace's copy. */
export async function createPlanVerifyApp(dir: string, files: Record<string, string> = PLAN_VERIFY_APP_FILES): Promise<string> {
  await writeWorkspaceFiles(dir, files)
  await linkWorkspaceCore(dir)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm'), join(dir, 'node_modules', 'drizzle-orm'), 'dir')
  return dir
}

/** A waiver on each of `elementIds`, for a test that verifies a step around what the fixture app leaves unwritten. */
export async function waiveForTest(planPath: string, elementIds: string[]): Promise<void> {
  await planWaiveFile(planPath, {
    elementIds,
    reason: 'outside what this test verifies',
    now: () => new Date('2026-09-23T12:00:00.000Z'),
    exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
  })
}
