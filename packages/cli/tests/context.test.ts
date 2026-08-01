import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { GUREN_API_DIGEST } from '../src/api-digest'
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
      await mkdir(join(workspace.dir, 'app/Console/Commands'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Http/Controllers/PostController.ts'), 'export default class {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Http/Resources/PostResource.ts'), 'export class PostResource {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Events/PostCreated.ts'), 'export class PostCreated {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Jobs/SendEmail.ts'), 'export class SendEmail {}', 'utf8')
      await writeFile(
        join(workspace.dir, 'app/Console/Commands/SendDigestCommand.ts'),
        'export default class SendDigestCommand {}',
        'utf8',
      )
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.controllers).toContain('PostController')
      expect(ctx.resources).toContain('PostResource')
      expect(ctx.events).toContain('PostCreated')
      expect(ctx.jobs).toContain('SendEmail')
      expect(ctx.commands).toContain('SendDigestCommand')
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
        docsTags: [],
      }],
      routes: [
        {
          method: 'GET',
          path: '/posts',
          name: 'posts.index',
          controller: { name: 'PostController', action: 'index' },
        },
      ],
      pages: ['posts/Index', 'posts/Show'],
      controllers: ['PostController'],
      resources: ['PostResource'],
      events: [],
      jobs: [],
      middleware: [],
      listeners: [],
      validators: [],
      policies: [],
      commands: ['SendDigestCommand'],
    })

    expect(md).toContain('# Project Context')
    expect(md).toContain('Guren 1.0.0')
    expect(md).toContain('### Post')
    expect(md).toContain('belongsTo: `author` → User')
    expect(md).toContain('| GET | /posts | posts.index | PostController.index |')
    expect(md).toContain('- posts/Index')
    expect(md).toContain('- PostController')
    expect(md).toContain('## Console Commands (1)')
    // Delivered at session start via the harness SessionStart hook
    expect(md).toContain(GUREN_API_DIGEST)
  })
})

describe('GUREN_API_DIGEST', () => {
  // The rule files are the source of truth; the digest is a hand-written
  // summary of them. Each token must appear in BOTH, so a one-sided edit
  // — fixing a rule file without the digest, or vice versa — fails here.
  const tokensByRuleFile: Record<string, string[]> = {
    'orm-models.md': [
      '`=` `!=` `>` `<` `>=` `<=` `like` `in` `not in` `is null` `is not null`',
      "belongsToMany(name, related, pivotTable, foreignPivotKey, relatedPivotKey, parentKey = 'id', relatedKey = 'id')",
      "hasManyThrough(name, related, through, firstKey, secondKey, localKey = 'id', secondLocalKey = 'id')",
      'paginate(result, { path?, query?, fragment? })',
      'PaginatorOptions',
      'withPaginate',
    ],
    'controllers-http.md': [
      'validateBody',
      'userOrFail',
      'bind: { id: Post }',
      "await this.authorize('update', [Post, post])",
    ],
    'testing.md': ['actingAs', 'withCsrf', 'assertUnprocessable', 'assertInertia'],
  }

  for (const [ruleFile, tokens] of Object.entries(tokensByRuleFile)) {
    it(`stays in sync with the ${ruleFile} rule file`, async () => {
      const ruleText = await readFile(
        new URL(`../templates/agent/.claude/rules/${ruleFile}`, import.meta.url),
        'utf8',
      )
      for (const token of tokens) {
        expect(GUREN_API_DIGEST).toContain(token)
        expect(ruleText).toContain(token)
      }
    })
  }
})
