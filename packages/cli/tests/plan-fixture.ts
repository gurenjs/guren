import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PlanAppState } from '../src/plan/app-state'
import type { PlanPagePayload } from '../src/plan/render'

export const TEST_BASELINE = { rev: '6445bc71', contextHash: { 'model.post': 'ab12' } }

/** A fresh object per call, so a test may mutate what it gets. */
export function loadCommentsPlan(): Record<string, unknown> {
  const text = readFileSync(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), 'utf8')
  return JSON.parse(text) as Record<string, unknown>
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
 * The same application on disk, for a test that goes through the command. It declares
 * no routes file, so the route section reads as an app with no routes rather than as
 * one nobody could read: both `plan:app-unreadable` warnings would otherwise count.
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
 * The page's data block, parsed back: what the page will actually read. Held apart
 * from the assertions on the block's *text*, which is where the escaping is pinned.
 */
export function planPageData(html: string): PlanPagePayload {
  const opening = '<script type="application/json" id="plan-data">'
  const start = html.indexOf(opening)
  if (start < 0) throw new Error('the rendered page carries no data block')
  const end = html.indexOf('</script>', start)
  return JSON.parse(html.slice(start + opening.length, end)) as PlanPagePayload
}
