import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { generateContext, renderContextMarkdown } from '../src/context'
import { createTempWorkspace } from './helpers'

describe('generateContext', () => {
  it('discovers models from app/Models', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Models/Post.ts'),
        `import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'
export class Post extends defineModel(posts) {}`,
        'utf8',
      )

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ dependencies: { '@guren/core': '1.0.0' } }),
        'utf8',
      )

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.framework.version).toBe('1.0.0')
      expect(ctx.models).toHaveLength(1)
      expect(ctx.models[0].className).toBe('Post')
      expect(ctx.models[0].tableName).toBe('posts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('discovers pages from resources/js/pages', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-pages-')

    try {
      await mkdir(join(workspace.dir, 'resources/js/pages/posts'), { recursive: true })
      await writeFile(join(workspace.dir, 'resources/js/pages/posts/Index.tsx'), 'export default function() {}', 'utf8')
      await writeFile(join(workspace.dir, 'resources/js/pages/posts/Show.tsx'), 'export default function() {}', 'utf8')
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.pages).toContain('posts/Index')
      expect(ctx.pages).toContain('posts/Show')
    } finally {
      await workspace.cleanup()
    }
  })

  it('discovers controllers, resources, events, jobs', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-components-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Resources'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Events'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Jobs'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Http/Controllers/PostController.ts'), 'export default class {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Http/Resources/PostResource.ts'), 'export class PostResource {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Events/PostCreated.ts'), 'export class PostCreated {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Jobs/SendEmail.ts'), 'export class SendEmail {}', 'utf8')
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.controllers).toContain('PostController')
      expect(ctx.resources).toContain('PostResource')
      expect(ctx.events).toContain('PostCreated')
      expect(ctx.jobs).toContain('SendEmail')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('renderContextMarkdown', () => {
  it('renders structured markdown', () => {
    const md = renderContextMarkdown({
      framework: { name: 'Guren', version: '1.0.0' },
      models: [{
        className: 'Post',
        filePath: 'app/Models/Post.ts',
        tableName: 'posts',
        relationships: [{ name: 'author', type: 'belongsTo', relatedModel: 'User' }],
        usesAuth: false,
        hasSoftDeletes: false,
      }],
      routes: [{ method: 'GET', path: '/posts', name: 'posts.index' }],
      pages: ['posts/Index', 'posts/Show'],
      controllers: ['PostController'],
      resources: ['PostResource'],
      events: [],
      jobs: [],
      middleware: [],
      listeners: [],
      validators: [],
    })

    expect(md).toContain('# Project Context')
    expect(md).toContain('Guren 1.0.0')
    expect(md).toContain('### Post')
    expect(md).toContain('belongsTo: `author` → User')
    expect(md).toContain('| GET | /posts | posts.index |')
    expect(md).toContain('- posts/Index')
    expect(md).toContain('- PostController')
  })
})
