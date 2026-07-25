import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  generateEntityContext,
  renderEntityContextMarkdown,
  EntityResolutionError,
} from '../src/entity-context'
import { createTempWorkspace } from './helpers'

async function writeBlogFixture(dir: string): Promise<void> {
  await mkdir(join(dir, 'app/Models'), { recursive: true })
  await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
  await mkdir(join(dir, 'app/Http/Resources'), { recursive: true })
  await mkdir(join(dir, 'app/Policies'), { recursive: true })
  await mkdir(join(dir, 'routes'), { recursive: true })
  await mkdir(join(dir, 'resources/js/pages/posts'), { recursive: true })
  await mkdir(join(dir, 'db/seeders'), { recursive: true })
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
  router.get('/posts', [PostController, 'index'] as any).name('posts.index')
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
    `export class PostController {
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
    join(dir, 'tests/controllers/PostController.test.ts'),
    'import { test } from "bun:test"\ntest("noop", () => {})\n',
    'utf8',
  )
}

describe('generateEntityContext', () => {
  it('joins model, routes, controller, pages, resource, policy, seeders, and tests', async () => {
    const workspace = await createTempWorkspace('guren-cli-entity-context-')

    try {
      await writeBlogFixture(workspace.dir)

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

      expect(ctx.controller?.filePath).toBe('app/Http/Controllers/PostController.ts')
      expect(ctx.controller?.actions).toEqual(['index', 'show'])

      expect(ctx.pages.map((p) => p.id)).toEqual(['posts/Index', 'posts/Show'])
      const index = ctx.pages.find((p) => p.id === 'posts/Index')
      expect(index?.props).toContain('posts')

      expect(ctx.resource?.filePath).toBe('app/Http/Resources/PostResource.ts')
      expect(ctx.policy?.filePath).toBe('app/Policies/PostPolicy.ts')
      expect(ctx.seeders).toEqual(['db/seeders/002_PostsSeeder.ts'])
      expect(ctx.tests).toContain('tests/controllers/PostController.test.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves entity names case-insensitively', async () => {
    const workspace = await createTempWorkspace('guren-cli-entity-case-')

    try {
      await writeBlogFixture(workspace.dir)

      const ctx = await generateEntityContext('post', { cwd: workspace.dir })

      expect(ctx.entity).toBe('Post')
    } finally {
      await workspace.cleanup()
    }
  })

  it('collects reverse relationship edges under referencedBy', async () => {
    const workspace = await createTempWorkspace('guren-cli-entity-reverse-')

    try {
      await writeBlogFixture(workspace.dir)

      const ctx = await generateEntityContext('User', { cwd: workspace.dir })

      expect(ctx.referencedBy).toEqual([
        { model: 'Post', relationship: 'author', type: 'belongsTo' },
      ])
      expect(ctx.routes).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('throws EntityResolutionError listing available models for unknown entities', async () => {
    const workspace = await createTempWorkspace('guren-cli-entity-unknown-')

    try {
      await writeBlogFixture(workspace.dir)

      expect(generateEntityContext('Ghost', { cwd: workspace.dir })).rejects.toThrow(
        EntityResolutionError,
      )
      expect(generateEntityContext('Ghost', { cwd: workspace.dir })).rejects.toThrow(
        'Available models: Post, User',
      )
    } finally {
      await workspace.cleanup()
    }
  })

  it('requires --module when the same model exists in multiple locations', async () => {
    const workspace = await createTempWorkspace('guren-cli-entity-ambiguous-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await mkdir(join(workspace.dir, 'modules/crm/app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')
      await writeFile(
        join(workspace.dir, 'app/Models/Post.ts'),
        'export class Post {}\n',
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/crm/app/Models/Post.ts'),
        'export class Post {}\n',
        'utf8',
      )

      expect(generateEntityContext('Post', { cwd: workspace.dir })).rejects.toThrow(
        'multiple locations: app, crm',
      )

      const ctx = await generateEntityContext('Post', { cwd: workspace.dir, module: 'crm' })
      expect(ctx.module).toBe('crm')
      expect(ctx.model.filePath).toBe('modules/crm/app/Models/Post.ts')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('renderEntityContextMarkdown', () => {
  it('renders the entity bundle as markdown', async () => {
    const workspace = await createTempWorkspace('guren-cli-entity-markdown-')

    try {
      await writeBlogFixture(workspace.dir)

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
      expect(md).toContain('## Seeders (1)')
      expect(md).toContain('## Tests (1)')
    } finally {
      await workspace.cleanup()
    }
  })

  it('renders reverse references for the target entity', async () => {
    const workspace = await createTempWorkspace('guren-cli-entity-md-reverse-')

    try {
      await writeBlogFixture(workspace.dir)

      const ctx = await generateEntityContext('User', { cwd: workspace.dir })
      const md = renderEntityContextMarkdown(ctx)

      expect(md).toContain('## Referenced by')
      expect(md).toContain('- Post — belongsTo `author`')
      expect(md).toContain('No routes reference this entity.')
    } finally {
      await workspace.cleanup()
    }
  })
})
