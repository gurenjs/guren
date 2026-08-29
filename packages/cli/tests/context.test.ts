import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { GUREN_API_DIGEST } from '../src/api-digest'
import { generateContext, renderContextMarkdown } from '../src/context'
import { CORE_RESOLVING_ROUTES_FIXTURE, createTempWorkspace, linkWorkspaceCore } from './helpers'

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
        `export default class SendDigestCommand {\n  static signature = 'send-digest'\n}`,
        'utf8',
      )
      // a helper module beside the commands is not a command — the listing
      // shares the registration check's predicate, so the two cannot disagree
      await writeFile(
        join(workspace.dir, 'app/Console/Commands/shared-config.ts'),
        `export const TABLES = ['users'] as const`,
        'utf8',
      )
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.controllers).toContain('PostController')
      expect(ctx.resources).toContain('PostResource')
      expect(ctx.events).toContain('PostCreated')
      expect(ctx.jobs).toContain('SendEmail')
      expect(ctx.commands).toContain('SendDigestCommand')
      expect(ctx.commands).not.toContain('SharedConfig')
    } finally {
      await workspace.cleanup()
    }
  })

  it('says the routes file could not be read, rather than reporting none', async () => {
    // The shape #482 fixed for `guren context <Entity>`, in the project-wide
    // map: an unloadable routes file used to render exactly what an app with
    // no routes renders — `## Routes (0)` / `No routes loaded.`, exit 0 — so
    // a reader could not tell a real answer from a failed one.
    const workspace = await createTempWorkspace('guren-cli-context-routes-broken-')

    try {
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'routes/web.ts'),
        "import { nothing } from 'package-that-is-not-installed'\nexport function registerWebRoutes(): void { nothing() }\n",
        'utf8',
      )
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.routes).toEqual([])
      expect(ctx.routesError).toContain('package-that-is-not-installed')
      // The renderer's three branches are mutually exclusive, so covering the
      // `routesError` one here is enough — the other two are covered by the
      // absent-file and named-typo cases below.
      expect(renderContextMarkdown(ctx)).toContain('Routes could not be read:')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a routes path that cannot even be probed, rather than crashing', async () => {
    // The absent-vs-unreadable split is a filesystem probe, and only ENOENT
    // answers "absent". A `routes` that is a regular file makes the probe
    // throw ENOTDIR (an unreadable parent throws EACCES); a probe that let
    // that escape would crash `guren context --json` with a stack trace
    // instead of the diagnostic, and one that read it as "absent" would print
    // the confident "No routes loaded." the split exists to prevent.
    const workspace = await createTempWorkspace('guren-cli-context-routes-notdir-')

    try {
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')
      await writeFile(join(workspace.dir, 'routes'), 'not a directory', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.routes).toEqual([])
      expect(ctx.routesError).toBeDefined()
      expect(renderContextMarkdown(ctx)).toContain('Routes could not be read:')
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports a routesFile that was named but is not there', async () => {
    // Absence is only a legitimate shape on the default path. A caller that
    // named the file gets the same diagnostic as any other unreadable one.
    const workspace = await createTempWorkspace('guren-cli-context-routes-typo-')

    try {
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir, routesFile: 'routes/nope.ts' })

      expect(ctx.routes).toEqual([])
      expect(ctx.routesError).toContain('nope.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps reporting no routes for an app that genuinely has none', async () => {
    const workspace = await createTempWorkspace('guren-cli-context-routes-absent-')

    try {
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.routes).toEqual([])
      expect(ctx.routesError).toBeUndefined()
      expect(renderContextMarkdown(ctx)).toContain('No routes loaded.')
    } finally {
      await workspace.cleanup()
    }
  })

  it('loads a routes file that imports @guren/core from this checkout', async () => {
    // The positive control for the above: proving the error path works is
    // worth nothing unless the success path is reached through the workspace.
    // A fixture with no node_modules otherwise resolves `@guren/core` by
    // Bun's auto-install fallback — the global cache, then npm — which is how
    // a green test comes to be measuring the published package, or the
    // registry, instead of this checkout.
    const workspace = await createTempWorkspace('guren-cli-context-routes-linked-')

    try {
      await linkWorkspaceCore(workspace.dir)
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      // The same fixture the resolution guard runs unlinked — the two are
      // each other's control, so they have to be one fixture.
      await writeFile(join(workspace.dir, 'routes/web.ts'), CORE_RESOLVING_ROUTES_FIXTURE, 'utf8')
      await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')

      const ctx = await generateContext({ cwd: workspace.dir })

      expect(ctx.routesError).toBeUndefined()
      expect(ctx.routes.map((route) => route.name)).toEqual(['posts.index'])
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
        attachments: null,
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
      "bind: { slug: [Post, 'slug'] }",
      "await this.authorize('update', [Post, post])",
    ],
    'routes-codegen.md': ['.agent({ description })', 'One declaration per route'],
    'testing.md': ['actingAs', 'withCsrf', 'assertUnprocessable', 'assertInertia', 'query(path, body?)'],
  }

  for (const [ruleFile, tokens] of Object.entries(tokensByRuleFile)) {
    it(`stays in sync with the ${ruleFile} rule file`, async () => {
      const ruleText = await readFile(
        new URL(`../templates/agent/core/rules/${ruleFile}`, import.meta.url),
        'utf8',
      )
      for (const token of tokens) {
        expect(GUREN_API_DIGEST).toContain(token)
        expect(ruleText).toContain(token)
      }
    })
  }
})
