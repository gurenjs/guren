import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { z } from 'zod'

import type { PlanAppState } from '../src/plan/app-state'
import type { PlanDraft, PlanDraftSchema } from '../src/plan/schema'
import type { PlanPagePayload } from '../src/plan/render'
import { FOUNDATION_TASK_ID, type PlanTaskDerivation } from '../src/plan/tasks'

export const TEST_BASELINE = { rev: '6445bc71', contextHash: { 'model.post': 'ab12' } }

/** A fresh object per call, so a test may mutate what it gets. */
export function loadCommentsPlan(): Record<string, unknown> {
  const text = readFileSync(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), 'utf8')
  return JSON.parse(text) as Record<string, unknown>
}

/** What a plan *document* spells, before parsing fills the defaults in. */
export type PlanInput = z.input<typeof PlanDraftSchema>

/** The comments fixture typed as a document, for a test that edits it section by section. */
export function loadCommentsPlanInput(): PlanInput {
  return loadCommentsPlan() as unknown as PlanInput
}

/** An application the comments fixture is a clean delta against. */
export function planAppState(overrides: Partial<PlanAppState> = {}): PlanAppState {
  return {
    models: ['Post', 'User'],
    controllers: ['PostController'],
    actions: ['PostController.index', 'PostController.show'],
    resources: ['PostResource'],
    policies: ['PostPolicy'],
    pages: ['posts/Index', 'posts/Show'],
    validators: { unreadable: 'validators are named by exported symbol' },
    routes: [
      { name: 'posts.index', method: 'GET', path: '/posts' },
      { name: 'posts.show', method: 'GET', path: '/posts/:id' },
    ],
    tables: [
      { identifier: 'posts', tableName: 'posts', columns: ['id', 'title', 'body'] },
      { identifier: 'users', tableName: 'users', columns: ['id', 'email'] },
    ],
    apiOnly: false,
    ...overrides,
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
