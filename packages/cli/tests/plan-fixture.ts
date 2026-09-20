import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { z } from 'zod'

import type { PlanAppState } from '../src/plan/app-state'
import type { PlanDraftSchema } from '../src/plan/schema'
import type { PlanPagePayload } from '../src/plan/render'

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
