import { mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runCheck, type CheckReport, type CheckResult, type RunCheckOptions } from '../src/check'
import {
  API_ONLY_APP_FILES,
  API_ONLY_REFUSAL,
  BLOG_ROUTES_FIXTURE,
  createTempWorkspace,
  PAGE_COMPONENT_FIXTURE,
  writeWorkspaceFiles,
  MYSQL_SCHEMA_FIXTURE,
  PG_SCHEMA_FIXTURE,
} from './helpers'

/** Run a check over a throwaway workspace built from path → content. */
async function withWorkspace(
  files: Record<string, string>,
  options: Partial<RunCheckOptions> = {},
): Promise<CheckReport> {
  const workspace = await createTempWorkspace('guren-cli-check-')
  try {
    await writeWorkspaceFiles(workspace.dir, files)
    return await runCheck({ cwd: workspace.dir, ...options })
  } finally {
    await workspace.cleanup()
  }
}

describe('runCheck', () => {
  it('detects empty controller methods', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-empty-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `import { Controller } from '@guren/core'
export default class PostController extends Controller {
  async index() {}
  async show() {
    return this.json({ ok: true })
  }
}`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const emptyCheck = report.checks.find(c => c.key.includes('empty-method'))
      expect(emptyCheck).toBeDefined()
      expect(emptyCheck!.status).toBe('warn')
      expect(emptyCheck!.message).toContain('index()')
    } finally {
      await workspace.cleanup()
    }
  })

  // extractClassDeclaration (shared with audit.ts/spec-screens.ts) also
  // matches a bare, non-exported class — a case the inline check this used to
  // do before this fix did not cover.
  it('detects an empty method on a bare, non-exported controller class', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-empty-bare-class-')
    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `class PostController {\n  index() {}\n}`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some((c) => c.key.startsWith('empty-method:'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  // `store = async () => {}` dispatches exactly like `async store() {}`, so it
  // is exactly as empty. Scanning only ClassMethod left it unreported.
  it('detects an empty class-field action, and does not flag a concise arrow', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-empty-field-')
    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `import { Controller } from '@guren/core'
export class PostController extends Controller {
  store = async () => {}
  show = () => this.inertia('posts/Show', {})
  perPage = 25
}`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })
      const keys = report.checks.filter((c) => c.key.startsWith('empty-method:')).map((c) => c.key)

      expect(keys).toEqual(['empty-method:PostController.store'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns about missing test files', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-tests-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `export default class PostController {
  async index() { return null }
}`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const testCheck = report.checks.find(c => c.key === 'test:PostController')
      expect(testCheck).toBeDefined()
      expect(testCheck!.status).toBe('warn')
      expect(testCheck!.suggestion).toContain('make:test')
    } finally {
      await workspace.cleanup()
    }
  })

  it('says the warning is about naming, not coverage, and lists what it looked for', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-test-wording-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await mkdir(join(workspace.dir, 'tests/controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/TaskController.ts'),
        `export default class TaskController {
  async index() { return null }
}`,
        'utf8',
      )
      // Covers the controller by driving its routes, the way the docs show —
      // it names neither the class nor its file, so detection cannot see it.
      await writeFile(
        join(workspace.dir, 'tests/controllers/tasks.test.ts'),
        `import { TestApp } from '@guren/testing'
test('lists tasks', async () => {
  const app = await TestApp.create()
  await app.get('/tasks').assertOk()
})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })
      const testCheck = report.checks.find((c) => c.key === 'test:TaskController')

      expect(testCheck!.status).toBe('warn')
      expect(testCheck!.message).toContain('No test file named after TaskController')
      expect(testCheck!.message).toContain('tests/controllers/TaskController.test.ts')
      expect(testCheck!.message).toContain('filename-only detection')
      expect(testCheck!.suggestion).toContain('If these routes are not already covered')
      // The old wording asserted an absence it cannot establish.
      expect(testCheck!.message).not.toContain('No test file found')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes when test file exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-tests-pass-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await mkdir(join(workspace.dir, 'tests/controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `export default class PostController {
  async index() { return null }
}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'tests/controllers/PostController.test.ts'),
        `test('index', () => {})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const testCheck = report.checks.find(c => c.key === 'test:PostController')
      expect(testCheck).toBeDefined()
      expect(testCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns about missing generated manifests', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-manifests-')

    try {
      const report = await runCheck({ cwd: workspace.dir })

      const manifestChecks = report.checks.filter(c => c.key.startsWith('manifest:'))
      expect(manifestChecks.length).toBeGreaterThan(0)
      // The agent manifest is the one conditional artifact: codegen writes it
      // only for apps that derive a tool, so a workspace with none is not
      // missing anything (RFC 0016).
      const agentManifest = manifestChecks.find(c => c.key === 'manifest:.guren/agents.gen.ts')
      expect(agentManifest?.status).toBe('pass')
      expect(agentManifest?.message).toContain('not applicable')
      const unconditional = manifestChecks.filter(c => c !== agentManifest)
      expect(unconditional.length).toBeGreaterThan(0)
      expect(unconditional.every(c => c.status === 'warn')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  describe('agent manifest (RFC 0016)', () => {
    const AGENT_ENTRY = `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => 'posts').name('posts.index').agent({})
}
`
    const agentCheck = (report: CheckReport) =>
      report.checks.find((c) => c.key === 'manifest:.guren/agents.gen.ts')

    it('points the remedy at the same routes file the finding was derived from', async () => {
      const report = await withWorkspace(
        { 'routes/api.ts': AGENT_ENTRY },
        { routesFile: 'routes/api.ts' },
      )

      const check = agentCheck(report)
      expect(check?.status).toBe('warn')
      // A bare `guren codegen` reads routes/web.ts, so it would write the
      // manifest from a different route graph — a remedy that cannot clear the
      // state it was printed for.
      expect(check?.suggestion).toContain('--routes routes/api.ts')
    })

    it('prints the plain command when no custom routes file is in play', async () => {
      const report = await withWorkspace({ 'routes/web.ts': AGENT_ENTRY })

      expect(agentCheck(report)?.suggestion).toBe('Run: bunx guren codegen')
    })

    it('reports a stale manifest, with the same clearing remedy', async () => {
      const report = await withWorkspace({
        'routes/web.ts': `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => 'posts').name('posts.index')
}
`,
        '.guren/agents.gen.ts': '// left over\n',
      })

      const check = agentCheck(report)
      expect(check?.status).toBe('warn')
      expect(check?.message).toContain('no longer exposes')
      expect(check?.suggestion).toContain('it removes')
    })

    it('is skipped under --changed when only non-source files changed', async () => {
      // The gate 7.7 and 8.7 share, and for their reason: this check loads the
      // app's route graph and derives every tool, so a docs-only run must not
      // pay a full module evaluation to re-derive an answer nothing in that
      // run could have changed.
      const workspace = await createTempWorkspace('guren-cli-check-agent-changed-')
      try {
        await writeWorkspaceFiles(workspace.dir, {
          'routes/web.ts': AGENT_ENTRY,
          'docs/notes.md': '# notes\n',
        })
        initGitRepo(workspace.dir)

        await writeFile(join(workspace.dir, 'docs/notes.md'), '# notes, edited\n', 'utf8')
        expect(agentCheck(await runCheck({ cwd: workspace.dir, changed: true }))).toBeUndefined()

        // …and a source edit wakes it again, so the gate is not simply off.
        await writeFile(
          join(workspace.dir, 'routes/web.ts'),
          `${AGENT_ENTRY}\n// touched\n`,
          'utf8',
        )
        expect(agentCheck(await runCheck({ cwd: workspace.dir, changed: true }))).toBeDefined()
      } finally {
        await workspace.cleanup()
      }
    })
  })

  it('reports correct counts', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-counts-')

    try {
      await mkdir(join(workspace.dir, '.guren'), { recursive: true })
      await writeFile(join(workspace.dir, '.guren/routes.gen.ts'), '', 'utf8')
      await writeFile(join(workspace.dir, '.guren/pages.gen.ts'), '', 'utf8')
      await writeFile(join(workspace.dir, '.guren/data.gen.ts'), '', 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.passCount).toBe(report.checks.filter(c => c.status === 'pass').length)
      expect(report.warnCount).toBe(report.checks.filter(c => c.status === 'warn').length)
      expect(report.failCount).toBe(report.checks.filter(c => c.status === 'fail').length)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not include arch results when guren.arch.ts is absent (unchanged output)', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-no-arch-')

    try {
      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some(c => c.key.startsWith('arch:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('merges arch boundary violations into the full report by default', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-arch-merge-')

    try {
      await writeFile(
        join(workspace.dir, 'guren.arch.ts'),
        `export default {
  layers: { domain: 'app/Domain/**', http: 'app/Http/**' },
  rules: [{ from: 'domain', disallow: ['http'] }],
}`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `export class PostController {}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Domain/OrderService.ts'),
        `import { PostController } from '../Http/Controllers/PostController'\nexport class OrderService {}`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const archViolation = report.checks.find(c => c.filePath === 'app/Domain/OrderService.ts')
      expect(archViolation).toBeDefined()
      expect(archViolation!.status).toBe('fail')
      expect(report.failCount).toBeGreaterThan(0)
      // Non-arch checks (e.g. missing test files) still ran alongside it.
      expect(report.checks.some(c => c.key.startsWith('test:'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('with arch:true, skips the route/controller/page/manifest checks', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-arch-only-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `export default class PostController {\n  async index() {}\n}`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir, arch: true })

      expect(report.checks.some(c => c.key.startsWith('empty-method:'))).toBe(false)
      expect(report.checks.some(c => c.key.startsWith('test:'))).toBe(false)
      expect(report.checks.some(c => c.key.startsWith('manifest:'))).toBe(false)
      expect(report.checks.some(c => c.key.startsWith('model-schema:'))).toBe(false)
      expect(report.checks.some(c => c.key.startsWith('module-schema-aggregation:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('with arch:true, does not run the module schema-aggregation check even when a module needs it', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-arch-only-schema-agg-')

    try {
      // A module schema that isn't re-exported from the root — outside
      // --arch mode this fails the schema-aggregation check (see the
      // "warns when a module schema exists but is not re-exported" test
      // below). --arch is documented as the architecture-boundary-only
      // fast path, so this unrelated check must not run under it.
      await mkdir(join(workspace.dir, 'modules/billing/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/db/schema.ts'), `export const invoices = {}`, 'utf8')
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const users = {}`, 'utf8')

      const report = await runCheck({ cwd: workspace.dir, arch: true })

      expect(report.checks.some(c => c.key.startsWith('module-schema-aggregation:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('with changed:true outside a git repo, checks everything (no filter applied)', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-changed-nogit-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `export default class PostController {\n  async index() {}\n}`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir, changed: true })

      const emptyCheck = report.checks.find(c => c.key.includes('empty-method'))
      expect(emptyCheck).toBeDefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('finds a module controller test under modules/<name>/tests/ instead of warning (RFC 0002)', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-module-test-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Http/Controllers/InvoiceController.ts'),
        `export default class InvoiceController {\n  async index() { return null }\n}`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'modules/billing/tests/controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/tests/controllers/InvoiceController.test.ts'),
        `test('index', () => {})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const testCheck = report.checks.find(c => c.key === 'test:InvoiceController')
      expect(testCheck).toBeDefined()
      expect(testCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts a co-located test next to a nested controller', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-colocated-test-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers/Auth'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.ts'),
        `export default class OAuthController {\n  async callback() { return null }\n}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.test.ts'),
        `test('callback', () => {})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const testCheck = report.checks.find(c => c.key === 'test:OAuthController')
      expect(testCheck).toBeDefined()
      expect(testCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts a co-located test next to a module controller', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-module-colocated-test-')

    try {
      await mkdir(join(workspace.dir, 'modules/blog/app/Http/Controllers/Auth'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/Auth/OAuthController.ts'),
        `export default class OAuthController {\n  async callback() { return null }\n}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/Auth/OAuthController.test.ts'),
        `test('callback', () => {})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const testCheck = report.checks.find(c => c.key === 'test:OAuthController')
      expect(testCheck).toBeDefined()
      expect(testCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts a co-located test that matches the controller\'s own extension', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-js-colocated-test-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/LegacyController.js'),
        `export default class LegacyController {\n  async index() { return null }\n}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/LegacyController.test.js'),
        `test('index', () => {})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const testCheck = report.checks.find(c => c.key === 'test:LegacyController')
      expect(testCheck).toBeDefined()
      expect(testCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not treat controller test files as controllers', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-test-not-controller-')

    try {
      await mkdir(join(workspace.dir, 'modules/blog/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/BlogController.ts'),
        `export default class BlogController {\n  async index() { return null }\n}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/BlogController.test.ts'),
        `test('index', () => {})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some(c => c.key === 'test:BlogController.test')).toBe(false)
      expect(report.checks.every(c => !c.key.endsWith('.test'))).toBe(true)
      const testCheck = report.checks.find(c => c.key === 'test:BlogController')
      expect(testCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('suggests --module in the make:test hint for a module controller missing a test', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-module-test-missing-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Http/Controllers/InvoiceController.ts'),
        `export default class InvoiceController {\n  async index() { return null }\n}`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const testCheck = report.checks.find(c => c.key === 'test:InvoiceController')
      expect(testCheck).toBeDefined()
      expect(testCheck!.status).toBe('warn')
      expect(testCheck!.suggestion).toContain('--module billing')
    } finally {
      await workspace.cleanup()
    }
  })

  it('checks a module model against the module\'s own db/schema.ts', async () => {
    const report = await withWorkspace({
      'modules/billing/app/Models/Invoice.ts': `import { defineModel } from '@guren/core'
import { invoices } from '../../db/schema'
export class Invoice extends defineModel(invoices) {}`,
      'modules/billing/db/schema.ts': `export const invoices = sqliteTable('invoices', {})`,
      // A top-level db/schema.ts that does NOT declare 'invoices' — proves the
      // check looks at the module's own schema file, not the root one.
      'db/schema.ts': `export const users = sqliteTable('users', {})`,
    })

    const schemaCheck = report.checks.find(c => c.key === 'model-schema:Invoice')
    expect(schemaCheck).toBeDefined()
    expect(schemaCheck!.status).toBe('pass')
  })

  // The check resolves the table the model binds, so a model whose class name
  // says nothing about its table is checked on what it actually declares.
  it('passes a model bound to a table not named after the class', async () => {
    const report = await withWorkspace({
      'app/Models/Post.ts': `import { defineModel } from '@guren/core'
import { blogPosts } from '@/db/schema'
export class Post extends defineModel(blogPosts) {}`,
      'db/schema.ts': `export const blogPosts = sqliteTable('blog_posts', {})`,
    })

    const schemaCheck = report.checks.find(c => c.key === 'model-schema:Post')
    expect(schemaCheck).toBeDefined()
    expect(schemaCheck!.status).toBe('pass')
    expect(schemaCheck!.message).toContain('blog_posts')
  })

  it('passes a model that reaches its table through a mixin', async () => {
    const report = await withWorkspace({
      'app/Models/Post.ts': `import { defineModel, SoftDeletes } from '@guren/core'
import { posts } from '@/db/schema'
export class Post extends SoftDeletes(defineModel(posts)) {}`,
      'db/schema.ts': `export const posts = sqliteTable('posts', {})`,
    })

    expect(report.checks.find(c => c.key === 'model-schema:Post')?.status).toBe('pass')
  })

  // The model's local name for the table and the schema's exported name are
  // written in different files and need not agree.
  it('passes a model that imports its table under an alias', async () => {
    const report = await withWorkspace({
      'app/Models/Post.ts': `import { defineModel } from '@guren/core'
import { posts as postTable } from '@/db/schema'
export class Post extends defineModel(postTable) {}`,
      'db/schema.ts': `export const posts = sqliteTable('posts', {})`,
    })

    expect(report.checks.find(c => c.key === 'model-schema:Post')?.status).toBe('pass')
  })

  it('warns when a module model binds a table only the root schema declares', async () => {
    const report = await withWorkspace({
      'modules/billing/app/Models/Invoice.ts': `import { defineModel } from '@guren/core'
import { invoices } from '@/db/schema'
export class Invoice extends defineModel(invoices) {}`,
      'modules/billing/db/schema.ts': `export const payments = sqliteTable('payments', {})`,
      'db/schema.ts': `export const invoices = sqliteTable('invoices', {})`,
    })

    const schemaCheck = report.checks.find(c => c.key === 'model-schema:Invoice')
    expect(schemaCheck!.status).toBe('warn')
    expect(schemaCheck!.suggestion).toContain('modules/billing/db/schema.ts')
  })

  it('passes a model that binds its table via static table', async () => {
    const report = await withWorkspace({
      'app/Models/Account.ts': `import { Model } from '@guren/orm'
import { accounts } from '@/db/schema'
export class Account extends Model {
  static table = accounts
}`,
      'db/schema.ts': `export const accounts = sqliteTable('accounts', {})`,
    })

    expect(report.checks.find(c => c.key === 'model-schema:Account')?.status).toBe('pass')
  })

  // The old check matched the guessed name as a substring of the schema
  // source, so a column named `posts` (or a comment mentioning it) counted as
  // a table definition.
  it('warns when the model binds a table the schema does not declare, even if the guessed name appears in it', async () => {
    const report = await withWorkspace({
      'app/Models/Post.ts': `import { defineModel } from '@guren/core'
import { articles } from '@/db/schema'
export class Post extends defineModel(articles) {}`,
      'db/schema.ts': `// the 'posts' table lives elsewhere
export const users = sqliteTable('users', {
  posts: integer('posts'),
})`,
    })

    const schemaCheck = report.checks.find(c => c.key === 'model-schema:Post')
    expect(schemaCheck).toBeDefined()
    expect(schemaCheck!.status).toBe('warn')
    expect(schemaCheck!.message).toContain("'articles'")
    expect(schemaCheck!.suggestion).toContain('users')
  })

  it('skips the model-schema check when the model binds no readable table', async () => {
    const report = await withWorkspace({
      'app/Models/Post.ts': 'export class Post {}',
      'db/schema.ts': `export const posts = sqliteTable('posts', {})`,
    })

    expect(report.checks.some(c => c.key.startsWith('model-schema:'))).toBe(false)
  })

  // parseSchemaTables reports nothing for a missing or unparsable schema, and
  // "no tables to compare against" is not evidence the model is wrong.
  it('skips the model-schema check when the schema declares no readable tables', async () => {
    const report = await withWorkspace({
      'app/Models/Post.ts': `import { defineModel } from '@guren/core'
import { posts } from '@/db/schema'
export class Post extends defineModel(posts) {}`,
      'db/schema.ts': 'export const posts = sqliteTable(',
    })

    expect(report.checks.some(c => c.key.startsWith('model-schema:'))).toBe(false)
  })

  it('passes the module schema-aggregation check when db/schema.ts re-exports the module', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-schema-agg-pass-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/db/schema.ts'), `export const invoices = {}`, 'utf8')
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export * from '../modules/billing/db/schema'`, 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const aggCheck = report.checks.find(c => c.key === 'module-schema-aggregation:billing')
      expect(aggCheck).toBeDefined()
      expect(aggCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when a module schema exists but is not re-exported from db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-schema-agg-missing-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/db/schema.ts'), `export const invoices = {}`, 'utf8')
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const users = {}`, 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const aggCheck = report.checks.find(c => c.key === 'module-schema-aggregation:billing')
      expect(aggCheck).toBeDefined()
      expect(aggCheck!.status).toBe('warn')
      expect(aggCheck!.suggestion).toContain("export * from '../modules/billing/db/schema'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when a module has a schema but the project has no root db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-schema-agg-no-root-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/db/schema.ts'), `export const invoices = {}`, 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const aggCheck = report.checks.find(c => c.key === 'module-schema-aggregation:billing')
      expect(aggCheck).toBeDefined()
      expect(aggCheck!.status).toBe('warn')
      expect(aggCheck!.message).toContain('no root db/schema.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  // A checker that skips a file it could not parse is indistinguishable from
  // one that found nothing wrong, which is how a decorated file could go
  // unchecked while the report still read clean.
  it('reports files that were skipped because they could not be parsed', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-scan-coverage-')
    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/BrokenController.ts'),
        'export class BrokenController { index( {{{{',
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const coverage = report.checks.find((c) => c.key === 'scan-coverage')
      expect(coverage?.status).toBe('warn')
      expect(coverage?.message).toContain('app/Http/Controllers/BrokenController.ts')
      expect(coverage?.message).toContain('unparsed')
    } finally {
      await workspace.cleanup()
    }
  })

  // Breadth is whatever the active suites asked the cache for, which the module
  // rules widen to every importable file. A junk file outside app/Http or
  // app/Models is therefore named too — accurate, since the boundary scan
  // genuinely could not read it — but it is a warn, so exit codes are unaffected.
  it('names files outside the controller/model dirs once module rules widen the scan', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-scan-coverage-wide-')
    try {
      await mkdir(join(workspace.dir, 'modules/billing'), { recursive: true })
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/index.ts'), 'export const billingModule = {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/junk.ts'), 'not valid {{{{ typescript', 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find((c) => c.key === 'scan-coverage')?.message).toContain('app/junk.ts')
      // A warn, never a fail — `check --arch` in CI must not start failing on it.
      expect(report.failCount).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('reports no scan-coverage warning when every file parses', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-scan-coverage-clean-')
    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        '@Injectable()\nexport class PostController {\n  index() { return 1 }\n}',
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some((c) => c.key === 'scan-coverage')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips a module with no db/schema.ts entirely (nothing to aggregate)', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-schema-agg-no-module-schema-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/index.ts'), `export const billingModule = {}`, 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some(c => c.key.startsWith('module-schema-aggregation:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  describe('Postgres timestamp time zones', () => {
    const timestamptzFindings = (report: CheckReport) =>
      report.checks.filter((c) => c.key.startsWith('schema-timestamptz:'))

    it('flags Postgres timestamp columns declared without withTimezone', async () => {
      const report = await withWorkspace({
        'db/schema.ts': `import { pgTable, serial, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  slots: timestamp('slots').array(),
  windows: timestamp('windows', { withTimezone: true }).array(),
})
`,
      })

      const findings = timestamptzFindings(report)
      // An exact list, so the tz'd columns above assert silence as strongly as
      // the bare ones assert detection — including through `.array()`, whose
      // `[]` suffix must neither hide a bare column nor surface a tz'd one.
      expect(findings.map((c) => c.key)).toEqual([
        'schema-timestamptz:posts.createdAt',
        'schema-timestamptz:posts.slots',
      ])
      expect(findings[0].status).toBe('warn')
      // The suggestion names the database column, not the object key.
      expect(findings[0].suggestion).toContain("timestamp('created_at', { withTimezone: true })")
      expect(findings[0].filePath).toBe('db/schema.ts')
      // Informational: the core suite never gates on exit code (see
      // check-exit-code.test.ts for that contract end to end).
      expect(report.failCount).toBe(0)
    })

    it('stays silent on the Postgres schema a fresh app is scaffolded with', async () => {
      const report = await withWorkspace({ 'db/schema.ts': PG_SCHEMA_FIXTURE })

      expect(timestamptzFindings(report)).toHaveLength(0)
    })

    // `{ withTimezone: false }` and omitting the option emit identical DDL, so
    // the explicit form is not a suppression mechanism.
    it('flags an explicit withTimezone: false the same as an omission', async () => {
      const report = await withWorkspace({
        'db/schema.ts': `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  createdAt: timestamp('created_at', { withTimezone: false }),
})
`,
      })

      expect(timestamptzFindings(report).map((c) => c.key)).toEqual(['schema-timestamptz:posts.createdAt'])
    })

    // MySQL's bare timestamp is correct (no timestamptz exists, and its
    // TIMESTAMP is already UTC-normalized) and is spelled identically to the
    // Postgres one — which is why the rule gates on the declaring table's
    // factory rather than the builder name. The fixture is the schema
    // `create-guren-app --db mysql` actually writes.
    it('ignores a MySQL schema, whose bare timestamp is spelled the same', async () => {
      const report = await withWorkspace({ 'db/schema.ts': MYSQL_SCHEMA_FIXTURE })

      expect(timestamptzFindings(report)).toHaveLength(0)
    })

    // One file can legally mix factories, so the verdict is per table.
    it('flags only the Postgres table in a mixed schema', async () => {
      const report = await withWorkspace({
        'db/schema.ts': `import { pgTable, timestamp } from 'drizzle-orm/pg-core'
import { mysqlTable, timestamp as mysqlTimestamp } from 'drizzle-orm/mysql-core'
import { sqliteTable, integer } from 'drizzle-orm/sqlite-core'

export const logs = mysqlTable('logs', { createdAt: mysqlTimestamp('created_at') })
export const notes = sqliteTable('notes', { createdAt: integer('created_at', { mode: 'timestamp' }) })
export const posts = pgTable('posts', { createdAt: timestamp('created_at') })
`,
      })

      expect(timestamptzFindings(report).map((c) => c.key)).toEqual(['schema-timestamptz:posts.createdAt'])
    })

    // Options the parser cannot read are not evidence of anything. Warning
    // here would be a false alarm whose suggested fix is a migration.
    it('stays silent when the options are not statically readable', async () => {
      const report = await withWorkspace({
        'db/schema.ts': `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

const INSTANT = { withTimezone: true } as const

export const posts = pgTable('posts', {
  viaConstant: timestamp('via_constant', INSTANT),
  viaAssertion: timestamp('via_assertion', { withTimezone: true as const }),
})
`,
      })

      expect(timestamptzFindings(report)).toHaveLength(0)
    })

    it('reports the module schema path for a module-declared table', async () => {
      const report = await withWorkspace({
        'modules/billing/db/schema.ts': `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

export const invoices = pgTable('invoices', { issuedAt: timestamp('issued_at') })
`,
      })

      const findings = timestamptzFindings(report)
      expect(findings).toHaveLength(1)
      expect(findings[0].filePath).toBe('modules/billing/db/schema.ts')
      expect(findings[0].suggestion).toContain('modules/billing/db/schema.ts')
    })

    // Under drizzle's name-less form the database name comes from a casing
    // config this parser does not read, so the SQL hint is dropped rather than
    // quoting the object key, which would not resolve.
    it('omits the USING hint when the column has no explicit database name', async () => {
      const report = await withWorkspace({
        'db/schema.ts': `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', { createdAt: timestamp() })
`,
      })

      const [finding] = timestamptzFindings(report)
      expect(finding.suggestion).toContain('timestamp({ withTimezone: true })')
      expect(finding.suggestion).not.toContain('AT TIME ZONE')
    })

    // The suggestion must not tell the user to replace an options object that
    // carries settings the rule knows nothing about.
    it('does not suggest dropping options the column already carries', async () => {
      const report = await withWorkspace({
        'db/schema.ts': `import { pgTable, timestamp } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  createdAt: timestamp('created_at', { mode: 'string', precision: 3 }),
})
`,
      })

      const [finding] = timestamptzFindings(report)
      expect(finding.suggestion).toContain('keeping any other options it already carries')
    })

    it('is skipped under --arch', async () => {
      const report = await withWorkspace(
        {
          'db/schema.ts': `import { pgTable, timestamp } from 'drizzle-orm/pg-core'
export const posts = pgTable('posts', { createdAt: timestamp('created_at') })
`,
        },
        { arch: true },
      )

      expect(timestamptzFindings(report)).toHaveLength(0)
    })
  })
})

/**
 * `.guren/pages.gen.ts` imports `@guren/inertia-client`, and the api blueprint's
 * tsconfig type-checks `.guren/**` without installing that package — so codegen
 * declines to write the manifest there, however many page components turn up.
 * That decision is only safe if it is visible: an app misread as API-only loses
 * a file its controllers import, and a manifest generated before the app took
 * this shape stays on disk failing the typecheck. Both states are reported here.
 */
describe('pages manifest on an API-only app', () => {
  const withPage = { ...API_ONLY_APP_FILES, 'resources/js/pages/Home.tsx': PAGE_COMPONENT_FIXTURE }
  const STALE_MANIFEST = '// generated when this app still had a client\n'

  it('warns that a manifest on disk is one codegen would not write', async () => {
    const report = await withWorkspace({ ...withPage, '.guren/pages.gen.ts': STALE_MANIFEST })

    const pagesCheck = report.checks.find((c) => c.key === 'pages-manifest')

    expect(pagesCheck?.status).toBe('warn')
    expect(pagesCheck?.message).toContain('1 page component under resources/js/pages')
    expect(pagesCheck?.message).toMatch(API_ONLY_REFUSAL)
    // Reported, never removed — codegen leaving it on disk is covered in
    // pages-types.test.ts, and is deliberate: if the rule is ever wrong about
    // an app, deleting the manifest turns a type error into a mystery.
    expect(pagesCheck?.suggestion).toContain('Delete .guren/pages.gen.ts')
    // This one really does fail `tsc`, so `check --ci` has to gate on it.
    expect(pagesCheck?.advisory).toBe(false)
  })

  // The page components can be deleted again while the manifest they produced
  // stays; nothing else in the run looks at a file codegen would not write.
  it('warns about the leftover manifest even after the pages are gone', async () => {
    const report = await withWorkspace({ ...API_ONLY_APP_FILES, '.guren/pages.gen.ts': STALE_MANIFEST })

    const pagesCheck = report.checks.find((c) => c.key === 'pages-manifest')

    expect(pagesCheck?.status).toBe('warn')
    expect(pagesCheck?.message).toContain('.guren/pages.gen.ts is present but codegen would not write it')
    expect(pagesCheck?.message).not.toContain('page component')
    expect(pagesCheck?.advisory).toBe(false)
  })

  it('reports page components no manifest will describe, without failing CI over them', async () => {
    const report = await withWorkspace(withPage)

    const pagesCheck = report.checks.find((c) => c.key === 'pages-manifest')

    expect(pagesCheck?.status).toBe('warn')
    expect(pagesCheck?.suggestion).toContain('add its @guren/inertia-client dependency')
    // Unused page components break nothing, so `check --ci` must not fail on
    // them the way it does on the leftover manifest above.
    expect(pagesCheck?.advisory).toBe(true)
    // Nothing is missing here, so the manifest must stay out of the list of
    // artifacts codegen is told to produce.
    expect(report.checks.some((c) => c.key === 'manifest:.guren/pages.gen.ts')).toBe(false)
  })

  it('says nothing about a fullstack app, which is still told to generate one', async () => {
    const report = await withWorkspace({
      ...withPage,
      'routes/web.ts': BLOG_ROUTES_FIXTURE,
    })

    expect(report.checks.some((c) => c.key === 'pages-manifest')).toBe(false)
    expect(report.checks.find((c) => c.key === 'manifest:.guren/pages.gen.ts')?.status).toBe('warn')
  })

  it('says nothing about an API-only app with no page components', async () => {
    const report = await withWorkspace(API_ONLY_APP_FILES)

    expect(report.checks.some((c) => c.key === 'pages-manifest')).toBe(false)
    expect(report.checks.some((c) => c.key === 'manifest:.guren/pages.gen.ts')).toBe(false)
  })
})

describe('mass-assignment config via defineModel options', () => {
  it('flags a denied credential column listed in the fillable option', async () => {
    const report = await withWorkspace({
      'app/Models/User.ts': `import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  fillable: ['name', 'email', 'passwordHash'],
}) {}`,
    })

    const denied = report.checks.find(c => c.key === 'mass-assignment-denied:User')
    expect(denied).toBeDefined()
    expect(denied!.status).toBe('fail')
    expect(denied!.message).toContain('passwordHash')
  })

  it('lets a static fillable shadow the option, matching the runtime', async () => {
    const report = await withWorkspace({
      'app/Models/User.ts': `import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  fillable: ['name', 'passwordHash'],
}) {
  static override fillable = ['name', 'email']
}`,
    })

    const denied = report.checks.find(c => c.key === 'mass-assignment-denied:User')
    expect(denied).toBeUndefined()
  })
})

/**
 * Init a repo at `dir` with everything committed, so `getChangedFiles`
 * starts from a clean baseline; returns a runner for further git commands.
 */
function initGitRepo(dir: string): (...args: string[]) => void {
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('add', '.')
  git('commit', '-m', 'initial')
  return git
}

describe('route registrar wiring', () => {
  /** Every `route-registrar:` finding, keyed by the file it names. */
  function wiring(report: CheckReport): Map<string, CheckResult> {
    return new Map(
      report.checks
        .filter((c) => c.key.startsWith('route-registrar:'))
        .map((c) => [c.key.replace('route-registrar:', ''), c]),
    )
  }

  const statusOf = (report: CheckReport, relPath: string): string | undefined =>
    wiring(report).get(relPath)?.status

  /** An entry registrar that mounts nothing but itself. */
  const PLAIN_ENTRY = `import { Router } from '@guren/core'

export function registerWebRoutes(baseRouter: Router): void {
  baseRouter.get('/', [HomeController, 'index'])
}
`

  const API_ENTRY = `import { Router } from '@guren/core'

export function registerApiRoutes(baseRouter: Router): void {
  baseRouter.get('/api/posts', [PostController, 'index'])
}
`

  const ROUTES_ENTRY = `import { Router } from '@guren/core'
import { registerAdminRoutes } from './admin.js'

export function registerWebRoutes(baseRouter: Router): void {
  registerAdminRoutes(baseRouter)
}
`

  const ADMIN_ROUTES = `import { Router } from '@guren/core'

export function registerAdminRoutes(router: Router): void {
  router.get('/admin', [AdminController, 'index'])
}

export default registerAdminRoutes
`

  // The specifier a Node-ESM app actually writes: `./admin.js` for a file
  // that is `admin.ts` on disk. Nothing else in this suite would notice a
  // resolver that only tried the specifier as written — it would report
  // every real app's routes files as unmounted.
  it('resolves a .js specifier back to the .ts file it names', async () => {
    const report = await withWorkspace({ 'routes/web.ts': ROUTES_ENTRY, 'routes/admin.ts': ADMIN_ROUTES })

    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
  })

  it('warns about a routes file the entry never imports', async () => {
    const report = await withWorkspace({ 'routes/web.ts': PLAIN_ENTRY, 'routes/admin.ts': ADMIN_ROUTES })

    const finding = wiring(report).get('routes/admin.ts')
    expect(finding?.status).toBe('warn')
    expect(finding!.message).toContain('404')
    expect(finding!.suggestion).toContain("import { registerAdminRoutes } from './admin.js'")
  })

  // The state the scaffolders' own patch is careful never to produce, and the
  // reason detection looks outside the imports rather than at them.
  it('warns when the entry imports the registrar but never calls it', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'
import { registerAdminRoutes } from './admin.js'

export function registerWebRoutes(baseRouter: Router): void {
  baseRouter.get('/', [HomeController, 'index'])
}
`,
      'routes/admin.ts': ADMIN_ROUTES,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('warn')
  })

  // Crediting the whole file for any binding would pass this: the entry uses
  // admin.ts, but only for a constant — the registrar beside it is dead.
  it('does not credit a file whose non-registrar export is the one imported', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'
import { ADMIN_PREFIX } from './admin.js'

export function registerWebRoutes(baseRouter: Router): void {
  baseRouter.group(ADMIN_PREFIX, (group) => group.get('/health', [HealthController, 'index']))
}
`,
      'routes/admin.ts': `import { Router } from '@guren/core'

export const ADMIN_PREFIX = '/admin'

export function registerAdminRoutes(router: Router): void {
  router.get('/users', [AdminController, 'index'])
}
`,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('warn')
  })

  it('follows a nested registrar called from another routes file', async () => {
    const report = await withWorkspace({
      'routes/web.ts': ROUTES_ENTRY,
      'routes/admin.ts': `import { Router } from '@guren/core'
import { registerAdminUserRoutes } from './admin-users.js'

export function registerAdminRoutes(router: Router): void {
  registerAdminUserRoutes(router)
}
`,
      'routes/admin-users.ts': `import { Router } from '@guren/core'

export function registerAdminUserRoutes(router: Router): void {
  router.get('/admin/users', [UserController, 'index'])
}
`,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
    expect(statusOf(report, 'routes/admin-users.ts')).toBe('pass')
  })

  // Mounting spreads from the entry, not over everything parsed: group.ts is
  // reachable (the entry re-exports it under a non-registrar name) but nobody
  // calls it, so the registrar it calls in turn is dead too.
  it('does not let an unmounted intermediate mount its descendants', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'

export { registerGroupRoutes as GROUP_REGISTRAR } from './group.js'

export function registerWebRoutes(baseRouter: Router): void {
  baseRouter.get('/', [HomeController, 'index'])
}
`,
      'routes/group.ts': `import { Router } from '@guren/core'
import { registerAdminRoutes } from './admin.js'

export function registerGroupRoutes(router: Router): void {
  registerAdminRoutes(router)
}
`,
      'routes/admin.ts': ADMIN_ROUTES,
    })

    expect(statusOf(report, 'routes/group.ts')).toBe('warn')
    expect(statusOf(report, 'routes/admin.ts')).toBe('warn')
  })

  // The barrel forwards the name; only `admin.ts` declares it, so credit has
  // to travel back along the `export ... from` edge.
  it('credits a registrar reached through a re-export barrel', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'
import { registerAdminRoutes } from './index.js'

export function registerWebRoutes(baseRouter: Router): void {
  registerAdminRoutes(baseRouter)
}
`,
      'routes/index.ts': `export { registerAdminRoutes } from './admin.js'
`,
      'routes/admin.ts': ADMIN_ROUTES,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
    // The barrel declares no registrar of its own, so it is not a candidate.
    expect(wiring(report).has('routes/index.ts')).toBe(false)
  })

  // ES semantics: the explicit re-export wins, so the same name coming through
  // `export *` is shadowed and its file is never called.
  it('does not credit an export * shadowed by an explicit re-export', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'
import { registerAdminRoutes } from './index.js'

export function registerWebRoutes(baseRouter: Router): void {
  registerAdminRoutes(baseRouter)
}
`,
      'routes/index.ts': `export * from './legacy-admin.js'
export { registerAdminRoutes } from './admin.js'
`,
      'routes/admin.ts': ADMIN_ROUTES,
      'routes/legacy-admin.ts': `import { Router } from '@guren/core'

export function registerAdminRoutes(router: Router): void {
  router.get('/legacy-admin', [LegacyAdminController, 'index'])
}
`,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
    expect(statusOf(report, 'routes/legacy-admin.ts')).toBe('warn')
  })

  // The loader resolves the registrar off the entry's exports, so one the
  // entry only forwards is called exactly as surely as one it declares.
  it('credits a registrar the entry re-exports rather than calls', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `export * from './admin.js'
`,
      'routes/admin.ts': ADMIN_ROUTES,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
  })

  it('credits a registrar called through a namespace import', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'
import * as admin from './admin.js'

export function registerWebRoutes(baseRouter: Router): void {
  admin.registerAdminRoutes(baseRouter)
}
`,
      'routes/admin.ts': ADMIN_ROUTES,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
  })

  // The runtime awaits an async registrar, so this really does mount — and a
  // dynamic import binds its names by destructuring, with no static local for
  // the reference test to find.
  it('credits a registrar reached by a dynamic import', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'

export async function registerWebRoutes(baseRouter: Router): Promise<void> {
  const { registerAdminRoutes } = await import('./admin.js')
  registerAdminRoutes(baseRouter)
}
`,
      'routes/admin.ts': ADMIN_ROUTES,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
  })

  it('ignores a routes file that exports no registrar', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'routes/prefixes.ts': `export const ADMIN_PREFIX = '/admin'
`,
    })

    expect(wiring(report).has('routes/prefixes.ts')).toBe(false)
  })

  // The loader takes a default export only when it is a function, so a routes
  // file defaulting to a config object is not an unmounted registrar.
  it('ignores a file whose default export is not a function', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'routes/prefixes.ts': `export default { admin: '/admin', api: '/api' }
`,
    })

    expect(wiring(report).has('routes/prefixes.ts')).toBe(false)
  })

  // An in-place TypeScript build drops `admin.js` beside `admin.ts`. The pair
  // is one routes file; counting the artifact separately would turn a working
  // routes/ into a failing check.
  it('ignores an emitted .js file sitting beside its .ts source', async () => {
    const report = await withWorkspace({
      'routes/web.ts': ROUTES_ENTRY,
      'routes/web.js': ROUTES_ENTRY,
      'routes/admin.ts': ADMIN_ROUTES,
      'routes/admin.js': ADMIN_ROUTES,
    })

    expect([...wiring(report).keys()]).toEqual(['routes/admin.ts'])
    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
  })

  it('contributes nothing when routes/ holds only the entry file', async () => {
    const report = await withWorkspace({ 'routes/web.ts': PLAIN_ENTRY })

    expect(wiring(report).size).toBe(0)
  })

  // `--routes` may point anywhere, so the entry is excluded by resolved path,
  // not by matching the conventional name.
  it('treats routes/web.ts as a candidate under a custom --routes entry', async () => {
    const report = await withWorkspace(
      { 'routes/api.ts': API_ENTRY, 'routes/web.ts': PLAIN_ENTRY },
      { routesFile: 'routes/api.ts' },
    )

    expect(statusOf(report, 'routes/web.ts')).toBe('warn')
    expect(wiring(report).has('routes/api.ts')).toBe(false)
  })

  /** A module registrar `defineModule({ routes })` names, mounting nothing. */
  const BILLING_ENTRY = `import { Router } from '@guren/core'

export function registerBillingRoutes(router: Router): void {
  router.get('/billing', [BillingController, 'index'])
}
`

  const BILLING_MODULE = `import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes.js'

export const billingModule = defineModule({ name: 'billing', routes: registerBillingRoutes, providers: [] })
`

  /** {@link BILLING_ENTRY}, wired: it mounts `routes/invoice.ts`. */
  const BILLING_ENTRY_WIRED = `import { Router } from '@guren/core'
import { registerRoutes } from './routes/invoice.js'

export function registerBillingRoutes(router: Router): void {
  registerRoutes(router)
}
`

  /** `make:route Invoice --module billing` output, wired to nothing. */
  const MODULE_ROUTE = `import { Router } from '@guren/core'
import InvoiceController from '../app/Http/Controllers/InvoiceController.js'

export function registerRoutes(router: Router): void {
  router.group('/invoice', (group) => {
    group.get('/', [InvoiceController, 'index'])
  })
}
`

  // A module mounts its routes through `defineModule({ routes })`, which names
  // one file — so a module whose whole surface is that file has nothing this
  // check asks about. The scope is content-activated on `modules/*/routes/`,
  // which is what keeps a real modular app (web/modules/blog) quiet.
  it('leaves a module with no routes/ directory alone', async () => {
    const report = await withWorkspace({
      'routes/web.ts': ROUTES_ENTRY,
      'routes/admin.ts': ADMIN_ROUTES,
      'modules/billing/routes.ts': BILLING_ENTRY,
      'modules/billing/index.ts': BILLING_MODULE,
    })

    expect(statusOf(report, 'routes/admin.ts')).toBe('pass')
    expect([...wiring(report).keys()].some((key) => key.startsWith('modules/'))).toBe(false)
  })

  // Where `make:route --module billing` writes. Nothing mounted it, and the
  // module's own registrar — not the app's — is the file that has to.
  it('warns about a module routes file the module registrar never calls', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'modules/billing/routes.ts': BILLING_ENTRY,
      'modules/billing/index.ts': BILLING_MODULE,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
    })

    const finding = wiring(report).get('modules/billing/routes/invoice.ts')
    expect(finding?.status).toBe('warn')
    expect(finding!.message).toContain('modules/billing/routes.ts')
    expect(finding!.message).toContain('404')
    // Printed relative to the module's entry, with the runtime extension.
    expect(finding!.suggestion).toContain("import { registerRoutes } from './routes/invoice.js'")
  })

  it('credits a module routes file its module registrar calls', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'modules/billing/routes.ts': BILLING_ENTRY_WIRED,
      'modules/billing/index.ts': BILLING_MODULE,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
    })

    expect(statusOf(report, 'modules/billing/routes/invoice.ts')).toBe('pass')
  })

  // The entry is the file `defineModule({ routes })` names, not a
  // conventionally named one: here a stale `routes.ts` sits beside the real
  // registrar at `routes/index.ts`, and judging against the convention would
  // report the whole directory unmounted. The entry is also one of the very
  // files the directory scan turns up, so it has to be excluded by resolved
  // path rather than reported against itself.
  it('follows defineModule({ routes }) to a registrar at routes/index.ts', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'modules/billing/routes.ts': BILLING_ENTRY,
      'modules/billing/index.ts': `import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes/index.js'

export const billingModule = defineModule({ name: 'billing', routes: registerBillingRoutes })
`,
      'modules/billing/routes/index.ts': `import { Router } from '@guren/core'
import { registerRoutes } from './invoice.js'

export function registerBillingRoutes(router: Router): void {
  registerRoutes(router)
}
`,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
    })

    expect(statusOf(report, 'modules/billing/routes/invoice.ts')).toBe('pass')
    expect(wiring(report).has('modules/billing/routes/index.ts')).toBe(false)
  })

  // The runtime mounts only what `defineModule({ routes })` names — a
  // descriptor without `routes` mounts nothing, however well-wired the
  // conventional `routes.ts` is internally. Judging against that file would
  // report a pass while every module route 404s.
  it('warns when defineModule names no routes registrar, however wired routes.ts is', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'modules/billing/routes.ts': BILLING_ENTRY_WIRED,
      'modules/billing/index.ts': `import { defineModule } from '@guren/core'

export const billingModule = defineModule({ name: 'billing' })
`,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
    })

    // One warning at the descriptor, no per-file verdicts: the only fix is
    // in defineModule(), not in any routes file.
    expect(wiring(report).size).toBe(0)
    const entry = report.checks.filter((c) => c.key === 'route-entry:modules/billing/index.ts')
    expect(entry).toHaveLength(1)
    expect(entry[0].status).toBe('warn')
    expect(entry[0].message).toContain('modules/billing/routes/invoice.ts')
    expect(entry[0].message).toContain('defineModule')
    expect(entry[0].suggestion).toContain('routes: registerBillingRoutes')
  })

  // No descriptor at all: the conventional entry stands in, so the warning
  // can name the file to create rather than describe its absence.
  it('reports a module with no descriptor and no routes entry once', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
      'modules/billing/routes/credit-note.ts': MODULE_ROUTE,
    })

    expect(wiring(report).size).toBe(0)
    const entry = report.checks.filter((c) => c.key === 'route-entry:modules/billing/routes.ts')
    expect(entry).toHaveLength(1)
    expect(entry[0].status).toBe('warn')
    expect(entry[0].message).toContain('modules/billing/routes/invoice.ts')
    // Creating the file alone leaves the routes unmounted, so both hops.
    expect(entry[0].suggestion).toContain('defineModule({ routes })')
  })

  // An inline registrar makes the descriptor itself the entry — its imports
  // are the wiring.
  it('credits a routes file mounted by an inline defineModule registrar', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'modules/billing/index.ts': `import { defineModule } from '@guren/core'
import { registerRoutes } from './routes/invoice.js'

export const billingModule = defineModule({
  name: 'billing',
  routes: (router) => {
    registerRoutes(router)
  },
})
`,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
    })

    expect(statusOf(report, 'modules/billing/routes/invoice.ts')).toBe('pass')
  })

  // A `routes` value the check cannot trace to a file must skip the module,
  // not judge it against a guessed entry — the looseness runs one way.
  it('skips a module whose routes value cannot be traced', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'modules/billing/index.ts': `import { defineModule } from '@guren/core'
import { buildRegistrar } from './support/build-registrar.js'

export const billingModule = defineModule({ name: 'billing', routes: buildRegistrar() })
`,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
    })

    expect(wiring(report).size).toBe(0)
    expect(report.checks.some((c) => c.key.startsWith('route-entry:modules/'))).toBe(false)
  })

  // Each module is judged against its own entry. Anything hoisted out of the
  // per-scope state — the candidate list, the parsed facts — would let one
  // module's registrar credit another's identically-named `registerRoutes`.
  it('judges each module against its own registrar', async () => {
    const report = await withWorkspace({
      'routes/web.ts': PLAIN_ENTRY,
      'modules/billing/routes.ts': BILLING_ENTRY_WIRED,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
      // The registrar's exported name does not matter to the scope split.
      'modules/shipping/routes.ts': BILLING_ENTRY,
      'modules/shipping/routes/label.ts': MODULE_ROUTE,
    })

    expect(statusOf(report, 'modules/billing/routes/invoice.ts')).toBe('pass')
    const orphan = wiring(report).get('modules/shipping/routes/label.ts')
    expect(orphan?.status).toBe('warn')
    expect(orphan!.message).toContain('modules/shipping/routes.ts')
  })

  // The app's entry registrar is not the module's. Calling a module's routes
  // file from `routes/web.ts` crosses the module boundary the arch rules draw
  // — it does not make the module mount it.
  it('does not credit a module routes file mounted from the project entry', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'
import { registerRoutes } from '../modules/billing/routes/invoice.js'

export function registerWebRoutes(baseRouter: Router): void {
  registerRoutes(baseRouter)
}
`,
      'modules/billing/routes.ts': BILLING_ENTRY,
      'modules/billing/index.ts': BILLING_MODULE,
      'modules/billing/routes/invoice.ts': MODULE_ROUTE,
    })

    expect(statusOf(report, 'modules/billing/routes/invoice.ts')).toBe('warn')
  })

  // `--routes` picks the *project's* entry; a module's is its own file.
  it('keeps a module scope on its own entry under a custom --routes', async () => {
    const report = await withWorkspace(
      {
        'routes/api.ts': API_ENTRY,
        'modules/billing/routes.ts': BILLING_ENTRY,
        'modules/billing/routes/invoice.ts': MODULE_ROUTE,
      },
      { routesFile: 'routes/api.ts' },
    )

    expect(wiring(report).get('modules/billing/routes/invoice.ts')!.message)
      .toContain('modules/billing/routes.ts')
  })

  it('reports a missing entry file once, not once per routes file', async () => {
    const report = await withWorkspace({
      'routes/admin.ts': ADMIN_ROUTES,
      'routes/oauth.ts': `import { Router } from '@guren/core'

export function registerOAuthRoutes(router: Router): void {
  router.get('/auth/github', [OAuthController, 'redirect'])
}
`,
    })

    expect(wiring(report).size).toBe(0)
    const entry = report.checks.filter((c) => c.key === 'route-entry:routes/web.ts')
    expect(entry).toHaveLength(1)
    expect(entry[0].status).toBe('warn')
    expect(entry[0].message).toContain('routes/admin.ts')
  })

  it('reports an unparseable entry file once, without judging the candidates', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `export function registerWebRoutes(router {{{`,
      'routes/admin.ts': ADMIN_ROUTES,
    })

    expect(wiring(report).size).toBe(0)
    const entry = report.checks.find((c) => c.key === 'route-entry:routes/web.ts')
    expect(entry?.status).toBe('warn')
    expect(entry?.message).toContain('could not be parsed')
  })

  // Two `make:route` outputs both export `registerRoutes`, so the obvious
  // import line would not compile once the first one is wired.
  it('flags the name collision two make:route files produce', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'
import { registerRoutes } from './reports.js'

export function registerWebRoutes(baseRouter: Router): void {
  registerRoutes(baseRouter)
}
`,
      'routes/reports.ts': `import { Router } from '@guren/core'

export function registerRoutes(router: Router): void {
  router.get('/reports', [ReportController, 'index'])
}
`,
      'routes/invoices.ts': `import { Router } from '@guren/core'

export function registerRoutes(router: Router): void {
  router.get('/invoices', [InvoiceController, 'index'])
}
`,
    })

    expect(statusOf(report, 'routes/reports.ts')).toBe('pass')
    expect(statusOf(report, 'routes/invoices.ts')).toBe('warn')
    expect(wiring(report).get('routes/invoices.ts')!.suggestion).toContain('under an alias')
  })

  // The API-only template ships `routes/api.ts` and no `routes/web.ts`, and
  // wires `--routes routes/api.ts` into its own codegen script — a bare
  // `guren check` there must not report the app as having no entry at all.
  it('falls back to routes/api.ts when there is no routes/web.ts', async () => {
    const report = await withWorkspace({ 'routes/api.ts': API_ENTRY })

    expect(wiring(report).size).toBe(0)
    expect(report.checks.some((c) => c.key.startsWith('route-entry:'))).toBe(false)
  })

  it('judges candidates against routes/api.ts when that is the only entry', async () => {
    const report = await withWorkspace({ 'routes/api.ts': API_ENTRY, 'routes/admin.ts': ADMIN_ROUTES })

    const finding = wiring(report).get('routes/admin.ts')
    expect(finding?.status).toBe('warn')
    expect(finding!.message).toContain('routes/api.ts')
    expect(finding!.suggestion).toContain('Add to routes/api.ts')
  })

  // The edit hook runs `runCheck({ changed: true })` on every save of a
  // controller, model, or page — none of which can move this answer, and all
  // of which would otherwise re-parse routes/ to re-derive it.
  it('is skipped under --changed when nothing under routes/ changed', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-routes-changed-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'routes/web.ts': PLAIN_ENTRY,
        'routes/admin.ts': ADMIN_ROUTES,
        'app/Http/Controllers/PostController.ts': 'export default class PostController {}\n',
      })
      initGitRepo(workspace.dir)

      // An unrelated edit must not wake it.
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        'export default class PostController { async index() {} }\n',
        'utf8',
      )
      expect(wiring(await runCheck({ cwd: workspace.dir, changed: true })).size).toBe(0)

      // A brand-new, never-committed routes file does — this is how
      // `make:route` output reaches the check, and the gate only sees it
      // because getChangedFiles unions `ls-files --others`.
      await writeFile(join(workspace.dir, 'routes/orphan.ts'), ADMIN_ROUTES, 'utf8')
      expect(statusOf(await runCheck({ cwd: workspace.dir, changed: true }), 'routes/orphan.ts')).toBe('warn')

      // Editing the entry — the change that actually breaks wiring — does.
      await writeFile(join(workspace.dir, 'routes/web.ts'), `${PLAIN_ENTRY}\n`, 'utf8')
      expect(statusOf(await runCheck({ cwd: workspace.dir, changed: true }), 'routes/admin.ts')).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
    // Spawns git and runs the suite twice; the default 5s budget is tight
    // enough that an unrelated slow machine turns this red.
  }, 30_000)

  // `make:route --module billing` writes under `modules/`, not `routes/`, so
  // the changed-file gate has to know that path too. Nothing under `routes/`
  // is touched here on purpose: with only the project directory in the gate,
  // this check would never run in the edit hook — the one path that passes
  // --changed — and the module half would be dead on arrival.
  it('wakes under --changed for a module routes file alone', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-module-routes-changed-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'routes/web.ts': PLAIN_ENTRY,
        'modules/billing/routes.ts': BILLING_ENTRY,
        'modules/billing/index.ts': BILLING_MODULE,
      })
      const git = initGitRepo(workspace.dir)

      // Committed state: nothing changed, so the check stays asleep.
      expect(wiring(await runCheck({ cwd: workspace.dir, changed: true })).size).toBe(0)

      await mkdir(join(workspace.dir, 'modules/billing/routes'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/routes/invoice.ts'), MODULE_ROUTE, 'utf8')

      expect(
        statusOf(await runCheck({ cwd: workspace.dir, changed: true }), 'modules/billing/routes/invoice.ts'),
      ).toBe('warn')

      // A descriptor-only edit — deleting `routes:` from defineModule() —
      // must wake it too: that one line severs every module route, and the
      // only changed path is modules/billing/index.ts.
      git('add', '.')
      git('commit', '-m', 'add invoice routes')
      await writeFile(
        join(workspace.dir, 'modules/billing/index.ts'),
        `import { defineModule } from '@guren/core'

export const billingModule = defineModule({ name: 'billing' })
`,
        'utf8',
      )
      const severed = await runCheck({ cwd: workspace.dir, changed: true })
      expect(severed.checks.some((c) => c.key === 'route-entry:modules/billing/index.ts' && c.status === 'warn'))
        .toBe(true)
    } finally {
      await workspace.cleanup()
    }
    // Spawns git and runs the suite three times, like the sibling gate test.
  }, 30_000)

  it('does not run under --arch', async () => {
    const report = await withWorkspace(
      { 'routes/web.ts': ROUTES_ENTRY, 'routes/admin.ts': ADMIN_ROUTES },
      { arch: true },
    )

    expect(wiring(report).size).toBe(0)
  })
})

describe('route path parameters', () => {
  /** Every `route-path-modifier:` finding, in the order reported. */
  const modifiers = (report: CheckReport): CheckResult[] =>
    report.checks.filter((c) => c.key.startsWith('route-path-modifier:'))

  const entryWith = (body: string): string => `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
${body}
}
`

  it('warns about a :name* parameter, naming what Hono actually registers', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.get('/files/:slug*', [FileController, 'show'])`),
    })

    const [finding, ...rest] = modifiers(report)
    expect(rest).toEqual([])
    expect(finding?.status).toBe('warn')
    expect(finding?.key).toBe('route-path-modifier:routes/web.ts:/files/:slug*')
    expect(finding?.filePath).toBe('routes/web.ts')
    // The two halves of the mistake: the name it really binds, and the name
    // the controller will ask for and not get.
    expect(finding?.message).toContain("named literally 'slug*'")
    expect(finding?.message).toContain("req.param('slug') is undefined")
    expect(finding?.suggestion).toContain("'/files/:slug{.+}'")
    // Not advisory: `check --ci` gates on this the way it does on an unmounted
    // registrar, so an app carrying one goes red there.
    expect(finding?.advisory).toBeUndefined()
  })

  // Real routes files register most of their routes inside a group callback,
  // so a top-level-statement scan would see almost nothing.
  it('sees routes registered inside a group callback', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.middleware('auth').group((auth) => {
    auth.get('/docs/:path*', [DocsController, 'show'])
  })`),
    })

    expect(modifiers(report).map((c) => c.key)).toEqual(['route-path-modifier:routes/web.ts:/docs/:path*'])
  })

  // on(method, path) puts the path in argument 1 — reading argument 0 would
  // inspect the verb and never see it.
  it('reads the path argument of on(), not the method', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.on('PURGE', '/cache/:key*', [CacheController, 'purge'])`),
    })

    expect(modifiers(report).map((c) => c.key)).toEqual(['route-path-modifier:routes/web.ts:/cache/:key*'])
  })

  it('warns about a group prefix carrying one, which every route inside inherits', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.group('/:tenant*', (scoped) => {
    scoped.get('/dashboard', [DashboardController, 'index'])
  })`),
    })

    expect(modifiers(report).map((c) => c.key)).toEqual(['route-path-modifier:routes/web.ts:/:tenant*'])
  })

  // resource() spreads one path over up to seven routes, and was the hole a
  // hand-kept mirror of Router's surface shipped with.
  it('warns about a resource path carrying one', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.resource('/files/:slug*', FileController)`),
    })

    expect(modifiers(report).map((c) => c.key)).toEqual(['route-path-modifier:routes/web.ts:/files/:slug*'])
  })

  // A path spelled as a no-substitution template literal is the same route.
  it('reads a template-literal path', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith('  router.get(`/files/:slug*`, [FileController, \'show\'])'),
    })

    expect(modifiers(report).map((c) => c.key)).toEqual(['route-path-modifier:routes/web.ts:/files/:slug*'])
  })

  // The optional form: detection and the suggested rewrite have to agree, or
  // the fix handed back is the path that was already wrong.
  it('suggests a rewrite that keeps the optional marker', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.get('/files/:slug*?', [FileController, 'show'])`),
    })

    const [finding] = modifiers(report)
    expect(finding?.suggestion).toContain("'/files/:slug{.+}?'")
  })

  // A star alongside a constraint has no single obvious rewrite, so the
  // suggestion falls back to naming the path rather than inventing one.
  it('leaves a constrained star parameter as written in the suggestion', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.get('/files/:slug*{[a-z]+}', [FileController, 'show'])`),
    })

    const [finding] = modifiers(report)
    expect(finding?.message).toContain("named literally 'slug*'")
    expect(finding?.suggestion).toContain("'/files/:slug*{[a-z]+}'")
    expect(finding?.suggestion).toContain("drop the '*' instead")
  })

  // A single star param at a time: the sentence is about one parameter, while
  // the suggested path fixes them all.
  it('reports one finding per path, however many stars it carries', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.get('/:tenant*/files/:slug*', [FileController, 'show'])`),
    })

    const [finding, ...rest] = modifiers(report)
    expect(rest).toEqual([])
    expect(finding?.message).toContain("named literally 'tenant*'")
    expect(finding?.suggestion).toContain("'/:tenant{.+}/files/:slug{.+}'")
  })

  // make:module scaffolds a single modules/<name>/routes.ts and no routes/
  // directory, so the module discovery this check shares with the wiring
  // check drops it — the file most modules actually route from.
  it('reads a module that keeps its routes in a single routes.ts', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.get('/', [HomeController, 'index'])`),
      'modules/billing/index.ts': `import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes.js'

export const billingModule = defineModule({ name: 'billing', routes: registerBillingRoutes })
`,
      'modules/billing/routes.ts': `import { Router } from '@guren/core'

export function registerBillingRoutes(router: Router): void {
  router.get('/invoices/:ref*', [InvoiceController, 'show'])
}
`,
    })

    expect(modifiers(report).map((c) => c.key)).toEqual([
      'route-path-modifier:modules/billing/routes.ts:/invoices/:ref*',
    ])
  })

  it('reads a module routes directory too', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(`  router.get('/', [HomeController, 'index'])`),
      'modules/billing/routes/invoice.ts': `import { Router } from '@guren/core'

export function registerInvoiceRoutes(router: Router): void {
  router.get('/invoices/:ref*', [InvoiceController, 'show'])
}
`,
    })

    expect(modifiers(report).map((c) => c.key)).toEqual([
      'route-path-modifier:modules/billing/routes/invoice.ts:/invoices/:ref*',
    ])
  })

  // The non-detections, in one app rather than seven: this is a per-segment
  // string predicate, and a failure still names the path it fired on. Three of
  // the seven contain a `*` — the `{.*}` one is what a rule matching a star
  // anywhere in the segment gets wrong, and it is also the syntax this check
  // tells people to move to.
  const SAFE_PATHS = [
    '/docs/:path{.+}',
    '/docs/:path{.*}',
    '/docs/:path{[^/]*}',
    '/reports/:month{[0-9]{2}}',
    '/assets/*',
    '/posts/:id?',
    '/posts/:id',
  ]

  it('says nothing about constrained parameters, wildcards, or optional parameters', async () => {
    const report = await withWorkspace({
      'routes/web.ts': entryWith(
        SAFE_PATHS.map((path) => `  router.get('${path}', [SomeController, 'show'])`).join('\n'),
      ),
    })

    expect(modifiers(report)).toEqual([])
  })

  // The member-call match is loose by design; the literal has to look like a
  // path before anything is reported.
  it('says nothing about a non-route .get() call in a routes file', async () => {
    const report = await withWorkspace({
      'routes/web.ts': `import { Router } from '@guren/core'

const labels = new Map<string, string>()

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index'])
  labels.get('/files/:slug*')
}
`,
    })

    expect(modifiers(report)).toEqual([])
  })

  // The edit hook runs `runCheck({ changed: true })` on every save, so this
  // path matters more than the unfiltered one — and it is the path where a
  // finding can vanish silently, since the file set comes from three
  // different producers and each POSIX-relative path has to match what git
  // reports for its file to be looked at at all.
  it('reports a :name* added to either a project or a module routes file under --changed', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-route-path-changed-')

    try {
      await writeWorkspaceFiles(workspace.dir, {
        'routes/web.ts': entryWith(`  router.get('/', [HomeController, 'index'])`),
        'modules/billing/index.ts': `import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes.js'

export const billingModule = defineModule({ name: 'billing', routes: registerBillingRoutes })
`,
        'modules/billing/routes.ts': `import { Router } from '@guren/core'

export function registerBillingRoutes(router: Router): void {
  router.get('/invoices', [InvoiceController, 'index'])
}
`,
        'app/Http/Controllers/HomeController.ts': 'export default class HomeController {}\n',
      })
      const git = initGitRepo(workspace.dir)

      const changed = async (): Promise<string[]> =>
        modifiers(await runCheck({ cwd: workspace.dir, changed: true })).map((c) => c.key)

      expect(await changed()).toEqual([])

      // The single-file module shape, whose path no `routes/` directory scan
      // produces.
      await writeFile(
        join(workspace.dir, 'modules/billing/routes.ts'),
        `import { Router } from '@guren/core'

export function registerBillingRoutes(router: Router): void {
  router.get('/invoices/:ref*', [InvoiceController, 'show'])
}
`,
        'utf8',
      )
      expect(await changed()).toEqual(['route-path-modifier:modules/billing/routes.ts:/invoices/:ref*'])

      await writeFile(
        join(workspace.dir, 'routes/web.ts'),
        entryWith(`  router.get('/files/:slug*', [FileController, 'show'])`),
        'utf8',
      )
      expect(await changed()).toEqual([
        'route-path-modifier:modules/billing/routes.ts:/invoices/:ref*',
        'route-path-modifier:routes/web.ts:/files/:slug*',
      ])

      // The other half of the filter, and the cost of it: once both are
      // committed, an unrelated edit says nothing about them. A plain
      // `guren check` is what surfaces what an app already carries.
      git('add', '.')
      git('commit', '-m', 'add routes')
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/HomeController.ts'),
        'export default class HomeController {\n  index() {}\n}\n',
        'utf8',
      )
      expect(await changed()).toEqual([])
      expect(modifiers(await runCheck({ cwd: workspace.dir }))).toHaveLength(2)
    } finally {
      await workspace.cleanup()
    }
    // Spawns git and runs the suite five times, like the sibling gate test.
  }, 30_000)

  it('does not run under --arch', async () => {
    const report = await withWorkspace(
      { 'routes/web.ts': entryWith(`  router.get('/files/:slug*', [FileController, 'show'])`) },
      { arch: true },
    )

    expect(modifiers(report)).toEqual([])
  })
})

/**
 * Wiring only. The comparison itself is covered by
 * `route-contract-check.test.ts`, which drives the check directly with real
 * zod schemas; a temp workspace cannot import zod (or any value from
 * `@guren/core`), so the fixture here binds a locally declared class instead.
 */
describe('runCheck route contracts', () => {
  const ROUTES_WITH_STRAY_BIND = `import type { Router } from '@guren/core'

class Post {
  static findOrFail() {
    return Promise.resolve({})
  }
}

export function registerWebRoutes(router: Router): void {
  router.group('/posts', (posts) => {
    posts.get('/:id', { bind: { slug: Post } }, () => new Response('ok'))
  })
}
`

  const contracts = (report: CheckReport): CheckResult[] =>
    report.checks.filter((c) => c.key.startsWith('route-contract'))

  it('reports a bind key the route path does not declare', async () => {
    const report = await withWorkspace({ 'routes/web.ts': ROUTES_WITH_STRAY_BIND })

    const results = contracts(report)
    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('fail')
    // The joined path, not the '/:id' the call site wrote: the check reads
    // registered definitions precisely so group prefixes are already applied.
    expect(results[0]?.message).toContain('/posts/:id')
  })

  it('does not run under --arch', async () => {
    const report = await withWorkspace({ 'routes/web.ts': ROUTES_WITH_STRAY_BIND }, { arch: true })

    expect(contracts(report)).toEqual([])
  })
})
