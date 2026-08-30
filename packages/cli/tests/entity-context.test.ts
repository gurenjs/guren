import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  generateEntityContext,
  renderEntityContextMarkdown,
  EntityResolutionError,
} from '../src/entity-context'
import { createTempWorkspace, type TempWorkspace } from './helpers'

async function writeBlogFixture(dir: string): Promise<void> {
  await mkdir(join(dir, 'app/Models'), { recursive: true })
  await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
  await mkdir(join(dir, 'app/Http/Resources'), { recursive: true })
  await mkdir(join(dir, 'app/Policies'), { recursive: true })
  await mkdir(join(dir, 'routes'), { recursive: true })
  await mkdir(join(dir, 'resources/js/pages/posts'), { recursive: true })
  await mkdir(join(dir, 'db/seeders'), { recursive: true })
  await mkdir(join(dir, 'db/factories'), { recursive: true })
  await mkdir(join(dir, 'tests/controllers'), { recursive: true })

  await writeFile(join(dir, 'package.json'), '{}', 'utf8')

  await writeFile(
    join(dir, 'db/schema.ts'),
    `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id'),
  title: text('title'),
  authorId: serial('author_id'),
})

export const users = pgTable('users', {
  id: serial('id'),
  email: text('email'),
})
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'app/Models/Post.ts'),
    `import { defineModel, type BelongsToRecord } from '@guren/orm'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export class Post extends defineModel(posts) {
  static override relationTypes: { author: BelongsToRecord<UserRecord> } = {
    author: null,
  }
}
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'app/Models/User.ts'),
    `import { defineModel, type HasManyRecord } from '@guren/orm'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

/**
 * @docs docs/context/users.md
 */
export class User extends defineModel(users) {
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'routes/web.ts'),
    `import type { Router } from '@guren/core'

class PostController {
  index() {}
  show() {}
}

class Post {
  static findOrFail(id: unknown) {
    return Promise.resolve({ id })
  }
}

export function registerWebRoutes(router: Router): void {
  router
    .get('/posts', [PostController, 'index'] as any)
    .name('posts.index')
    .agent({ description: 'List published posts.', idempotentHint: true })
  router.get('/posts/:id', { name: 'posts.show', bind: { id: Post } } as any, [
    PostController,
    'show',
  ] as any)
  router.get('/about', () => new Response('ok')).name('about')
}
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'app/Http/Controllers/PostController.ts'),
    `class UnexportedHelper {
  irrelevant() {
    return null
  }
}

export class PostController {
  async index() {
    return this.inertia('posts/Index', { posts: [] })
  }

  async show() {
    return this.inertia(pages.posts.Show, { post: null })
  }

  private helper() {
    return null
  }
}
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'resources/js/pages/posts/Index.tsx'),
    `interface Props {
  posts: string[]
}

export default function Index({ posts }: Props) {
  return null
}
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'resources/js/pages/posts/Show.tsx'),
    'export default function Show() { return null }\n',
    'utf8',
  )

  await writeFile(
    join(dir, 'app/Http/Resources/PostResource.ts'),
    'export class PostResource {}\n',
    'utf8',
  )
  await writeFile(join(dir, 'app/Policies/PostPolicy.ts'), 'export class PostPolicy {}\n', 'utf8')
  await writeFile(
    join(dir, 'db/seeders/002_PostsSeeder.ts'),
    'export async function seed() {}\n',
    'utf8',
  )
  await writeFile(
    join(dir, 'db/factories/PostFactory.ts'),
    'export default class PostFactory {}\n',
    'utf8',
  )
  await writeFile(
    join(dir, 'tests/controllers/PostController.test.ts'),
    'import { test } from "bun:test"\ntest("noop", () => {})\n',
    'utf8',
  )

  await mkdir(join(dir, 'docs/adr'), { recursive: true })
  await mkdir(join(dir, 'docs/context'), { recursive: true })
  await writeFile(
    join(dir, 'docs/adr/0001-posts-are-public.md'),
    `---
type: adr
status: stable
entities: [Post]
generated: { by: human:ada, at: 2026-07-20T09:00:00Z }
verified: { by: human:grace, at: 2026-07-25T09:00:00Z }
---

# Posts are public by default
`,
    'utf8',
  )
  await writeFile(join(dir, 'docs/context/users.md'), '# User lifecycle\n', 'utf8')
}

// The blog fixture is read-only for every test in this file, so one shared
// workspace serves them all (createTempWorkspace chdirs; tests run serially).
describe('entity context (blog fixture)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-entity-context-')
    await writeBlogFixture(workspace.dir)
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('joins model, routes, controller, pages, resource, policy, factories, seeders, and tests', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir })

    expect(ctx.entity).toBe('Post')
    expect(ctx.module).toBeUndefined()

    expect(ctx.model.filePath).toBe('app/Models/Post.ts')
    expect(ctx.model.tableName).toBe('posts')
    expect(ctx.model.columns).toEqual(['id', 'title', 'authorId'])
    expect(ctx.model.relationships).toEqual([
      { name: 'author', type: 'belongsTo', relatedModel: 'User' },
    ])

    // posts.index via controller-name convention, posts.show via bind — not /about
    expect(ctx.routes).toHaveLength(2)
    expect(ctx.routes.map((r) => r.name).sort()).toEqual(['posts.index', 'posts.show'])
    const show = ctx.routes.find((r) => r.name === 'posts.show')
    expect(show?.bindings).toEqual({ id: 'Post' })
    expect(show?.controller).toEqual({ name: 'PostController', action: 'show' })

    // Exported controller class wins over the unexported helper above it
    expect(ctx.controller?.filePath).toBe('app/Http/Controllers/PostController.ts')
    expect(ctx.controller?.actions).toEqual(['index', 'show'])

    expect(ctx.pages.map((p) => p.id)).toEqual(['posts/Index', 'posts/Show'])
    const index = ctx.pages.find((p) => p.id === 'posts/Index')
    expect(index?.props).toContain('posts')

    expect(ctx.resource).toBe('app/Http/Resources/PostResource.ts')
    expect(ctx.policy).toBe('app/Policies/PostPolicy.ts')
    expect(ctx.factories).toEqual(['db/factories/PostFactory.ts'])
    expect(ctx.seeders).toEqual(['db/seeders/002_PostsSeeder.ts'])
    expect(ctx.tests).toContain('tests/controllers/PostController.test.ts')
  })

  it('links docs via frontmatter entities and code-side @docs tags', async () => {
    const post = await generateEntityContext('Post', { cwd: workspace.dir })
    expect(post.docs).toEqual([
      {
        path: 'docs/adr/0001-posts-are-public.md',
        title: 'Posts are public by default',
        type: 'adr',
        status: 'stable',
        description: undefined,
        generatedAt: '2026-07-20T09:00:00Z',
        verifiedAt: '2026-07-25T09:00:00Z',
      },
    ])

    const user = await generateEntityContext('User', { cwd: workspace.dir })
    expect(user.docs).toEqual([
      {
        path: 'docs/context/users.md',
        title: 'User lifecycle',
        type: undefined,
        status: undefined,
        description: undefined,
        generatedAt: undefined,
        verifiedAt: undefined,
      },
    ])
  })

  it('reports the chronologically latest verification, not the lexically last', async () => {
    const scoped = await createTempWorkspace('guren-cli-entity-verified-')
    try {
      await mkdir(join(scoped.dir, 'app/Models'), { recursive: true })
      await mkdir(join(scoped.dir, 'docs'), { recursive: true })
      await writeFile(join(scoped.dir, 'package.json'), '{}', 'utf8')
      await writeFile(join(scoped.dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')
      // The first entry sorts later as a string but is the earlier instant.
      await writeFile(
        join(scoped.dir, 'docs/posts.md'),
        `---
type: adr
entities: [Post]
verified:
  - { by: human:a, at: 2026-01-01T00:00:00+09:00 }
  - { by: human:b, at: 2025-12-31T16:00:00Z }
---
# Posts
`,
        'utf8',
      )

      const ctx = await generateEntityContext('Post', { cwd: scoped.dir })

      expect(ctx.docs[0].verifiedAt).toBe('2025-12-31T16:00:00Z')
    } finally {
      await scoped.cleanup()
    }
  })

  it('renders the Linked docs section', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir })
    const md = renderEntityContextMarkdown(ctx)

    expect(md).toContain('## Linked docs (1)')
    expect(md).toContain(
      '- docs/adr/0001-posts-are-public.md — Posts are public by default (adr, stable, verified 2026-07-25T09:00:00Z)',
    )
  })

  it('resolves entity names case-insensitively', async () => {
    const ctx = await generateEntityContext('post', { cwd: workspace.dir })

    expect(ctx.entity).toBe('Post')
  })

  it('collects reverse relationship edges under referencedBy', async () => {
    const ctx = await generateEntityContext('User', { cwd: workspace.dir })

    expect(ctx.referencedBy).toEqual([
      { model: 'Post', relationship: 'author', type: 'belongsTo' },
    ])
    expect(ctx.routes).toHaveLength(0)
  })

  it('throws EntityResolutionError listing available models for unknown entities', async () => {
    expect(generateEntityContext('Ghost', { cwd: workspace.dir })).rejects.toThrow(
      EntityResolutionError,
    )
    expect(generateEntityContext('Ghost', { cwd: workspace.dir })).rejects.toThrow(
      'Available models: Post, User',
    )
  })

  it('renders the entity bundle as markdown', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir })
    const md = renderEntityContextMarkdown(ctx)

    expect(md).toContain('# Post')
    expect(md).toContain('## Model — app/Models/Post.ts (table: `posts`)')
    expect(md).toContain('- Columns: id, title, authorId')
    expect(md).toContain('- belongsTo: `author` → User')
    expect(md).toContain('## Routes (2)')
    expect(md).toContain('| GET | /posts | posts.index | PostController.index |')
    expect(md).toContain('- Actions: index, show')
    expect(md).toContain('- posts/Index — Props:')
    expect(md).toContain('## Resource — app/Http/Resources/PostResource.ts')
    expect(md).toContain('## Policy — app/Policies/PostPolicy.ts')
    expect(md).toContain('## Factories (1)')
    expect(md).toContain('## Seeders (1)')
    expect(md).toContain('## Tests (1)')
  })

  it('renders the Agent Interfaces section for routes that declare .agent()', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir })
    const md = renderEntityContextMarkdown(ctx)

    // One of the entity's two routes declares agent metadata, so the section
    // describes that route alone.
    expect(md).toContain('## Agent Interfaces (1)')
    expect(md).toContain('### posts.index')
    expect(md).toContain('- Route: `GET /posts`')
    expect(md).toContain('- Description: List published posts.')
    expect(md).toContain('- Output: no output schema declared')
    expect(md).toContain('- Authorization: none derivable from the middleware chain')
    expect(md).toContain('- Annotations: idempotentHint: true')
    expect(md).toContain('- Approval: not required')
  })

  it('renders reverse references for the target entity', async () => {
    const ctx = await generateEntityContext('User', { cwd: workspace.dir })
    const md = renderEntityContextMarkdown(ctx)

    expect(md).toContain('## Referenced by')
    expect(md).toContain('- Post — belongsTo `author`')
    expect(md).toContain('No routes reference this entity.')
  })
})

describe('entity context (duplicated entity across locations)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-entity-ambiguous-')
    const dir = workspace.dir

    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await mkdir(join(dir, 'app/Http/Resources'), { recursive: true })
    await mkdir(join(dir, 'db/seeders'), { recursive: true })
    await mkdir(join(dir, 'modules/crm/app/Models'), { recursive: true })
    await mkdir(join(dir, 'modules/crm/app/Http/Resources'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')

    await writeFile(join(dir, 'app/Models/Post.ts'), 'export class Post {}\n', 'utf8')
    await writeFile(
      join(dir, 'modules/crm/app/Models/Post.ts'),
      'export class Post {}\n',
      'utf8',
    )
    await writeFile(
      join(dir, 'app/Http/Resources/PostResource.ts'),
      'export class PostResource {}\n',
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/crm/app/Http/Resources/PostResource.ts'),
      'export class PostResource {}\n',
      'utf8',
    )
    // Root-only seeder: must not leak into the crm bundle
    await writeFile(
      join(dir, 'db/seeders/001_PostsSeeder.ts'),
      'export async function seed() {}\n',
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('requires --module when the same model exists in multiple locations', async () => {
    expect(generateEntityContext('Post', { cwd: workspace.dir })).rejects.toThrow(
      'multiple locations: app, crm',
    )
  })

  it('scopes every join to the selected module', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir, module: 'crm' })

    expect(ctx.module).toBe('crm')
    expect(ctx.model.filePath).toBe('modules/crm/app/Models/Post.ts')
    expect(ctx.resource).toBe('modules/crm/app/Http/Resources/PostResource.ts')
    expect(ctx.seeders).toEqual([])
  })

  it('selects the application root via --module app', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir, module: 'app' })

    expect(ctx.module).toBeUndefined()
    expect(ctx.model.filePath).toBe('app/Models/Post.ts')
    expect(ctx.resource).toBe('app/Http/Resources/PostResource.ts')
    expect(ctx.seeders).toEqual(['db/seeders/001_PostsSeeder.ts'])
  })
})

// `make:factory Categories` writes `CategoriesFactory.ts` — the command
// appends its suffix without inflecting — so discovery has to accept the
// inflected plural, not just a trailing `s`.
describe('entity context (irregular plural db artifacts)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-entity-plural-')
    const dir = workspace.dir

    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await mkdir(join(dir, 'db/factories'), { recursive: true })
    await mkdir(join(dir, 'db/seeders'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')

    await writeFile(join(dir, 'app/Models/Category.ts'), 'export class Category {}\n', 'utf8')
    await writeFile(join(dir, 'app/Models/Box.ts'), 'export class Box {}\n', 'utf8')
    // `$` is legal in an identifier and an anchor in a regex.
    await writeFile(join(dir, 'app/Models/$Ledger.ts'), 'export class $Ledger {}\n', 'utf8')

    await writeFile(
      join(dir, 'db/factories/CategoriesFactory.ts'),
      'export default class CategoriesFactory {}\n',
      'utf8',
    )
    await writeFile(
      join(dir, 'db/seeders/003_CategoriesSeeder.ts'),
      'export async function seed() {}\n',
      'utf8',
    )
    // The naive `+s` plural a user may have typed into `make:factory`. Matched
    // before the inflection rule existed, so it must keep matching.
    await writeFile(
      join(dir, 'db/factories/CategorysFactory.ts'),
      'export default class CategorysFactory {}\n',
      'utf8',
    )
    // Singular naming must keep working alongside all of it.
    await writeFile(
      join(dir, 'db/factories/BoxFactory.ts'),
      'export default class BoxFactory {}\n',
      'utf8',
    )
    await writeFile(
      join(dir, 'db/factories/$LedgerFactory.ts'),
      'export default class $LedgerFactory {}\n',
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('finds factories and seeders named with the inflected plural', async () => {
    const ctx = await generateEntityContext('Category', { cwd: workspace.dir })

    expect(ctx.factories).toEqual([
      'db/factories/CategoriesFactory.ts',
      'db/factories/CategorysFactory.ts',
    ])
    expect(ctx.seeders).toEqual(['db/seeders/003_CategoriesSeeder.ts'])
  })

  it('still finds artifacts named with the singular', async () => {
    const ctx = await generateEntityContext('Box', { cwd: workspace.dir })

    expect(ctx.factories).toEqual(['db/factories/BoxFactory.ts'])
    // No seeder is named after Box, so another entity's must not stand in.
    expect(ctx.seeders).toEqual([])
  })

  it('treats regex metacharacters in the entity name as literals', async () => {
    const ctx = await generateEntityContext('$Ledger', { cwd: workspace.dir })

    expect(ctx.factories).toEqual(['db/factories/$LedgerFactory.ts'])
  })
})

describe('entity context (attachments)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-entity-attachments-')
    const dir = workspace.dir

    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    await writeFile(
      join(dir, 'app/Models/Post.ts'),
      `import { Attachable, hasOneAttached, hasManyAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({ variants: { thumb: { width: 320 }, og: { width: 1200 } } }),
  images: hasManyAttached(),
}) {}
`,
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('lists attachment collections on the model', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir })

    expect(ctx.model.attachments).toEqual([
      { name: 'cover', kind: 'one', variants: ['thumb', 'og'] },
      { name: 'images', kind: 'many', variants: [] },
    ])
    expect(ctx.model.attachmentsUnreadable).toBe(false)
  })

  it('renders attachment collections in the markdown bundle', async () => {
    const ctx = await generateEntityContext('Post', { cwd: workspace.dir })
    const markdown = renderEntityContextMarkdown(ctx)

    expect(markdown).toContain('- hasOneAttached: `cover` (variants: thumb, og)')
    expect(markdown).toContain('- hasManyAttached: `images`')
  })
})
