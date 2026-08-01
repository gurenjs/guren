import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runCheck, type CheckReport, type RunCheckOptions } from '../src/check'
import { createTempWorkspace, MYSQL_SCHEMA_FIXTURE, PG_SCHEMA_FIXTURE } from './helpers'

async function writeModel(dir: string, fileName: string, source: string): Promise<void> {
  await mkdir(join(dir, 'app/Models'), { recursive: true })
  await writeFile(join(dir, 'app/Models', fileName), source, 'utf8')
}

async function writeSchema(dir: string, source: string): Promise<void> {
  await mkdir(join(dir, 'db'), { recursive: true })
  await writeFile(join(dir, 'db/schema.ts'), source, 'utf8')
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
      expect(manifestChecks.every(c => c.status === 'warn')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
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
    const workspace = await createTempWorkspace('guren-cli-check-module-schema-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Models/Invoice.ts'),
        `import { defineModel } from '@guren/core'
import { invoices } from '../../db/schema'
export class Invoice extends defineModel(invoices) {}`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'modules/billing/db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/db/schema.ts'),
        `export const invoices = sqliteTable('invoices', {})`,
        'utf8',
      )
      // A top-level db/schema.ts that does NOT mention 'invoices' — proves the
      // check looks at the module's own schema file, not the root one.
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export const users = sqliteTable('users', {})`, 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const schemaCheck = report.checks.find(c => c.key === 'model-schema:Invoice')
      expect(schemaCheck).toBeDefined()
      expect(schemaCheck!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  // The check resolves the table the model binds, so a model whose class name
  // says nothing about its table is checked on what it actually declares.
  it('passes a model bound to a table not named after the class', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-model-renamed-table-')

    try {
      await writeModel(
        workspace.dir,
        'Post.ts',
        `import { defineModel } from '@guren/core'
import { blogPosts } from '@/db/schema'
export class Post extends defineModel(blogPosts) {}`,
      )
      await writeSchema(workspace.dir, `export const blogPosts = sqliteTable('blog_posts', {})`)

      const report = await runCheck({ cwd: workspace.dir })

      const schemaCheck = report.checks.find(c => c.key === 'model-schema:Post')
      expect(schemaCheck).toBeDefined()
      expect(schemaCheck!.status).toBe('pass')
      expect(schemaCheck!.message).toContain('blog_posts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes a model that binds its table via static table', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-model-static-table-')

    try {
      await writeModel(
        workspace.dir,
        'Account.ts',
        `import { Model } from '@guren/orm'
import { accounts } from '@/db/schema'
export class Account extends Model {
  static table = accounts
}`,
      )
      await writeSchema(workspace.dir, `export const accounts = sqliteTable('accounts', {})`)

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find(c => c.key === 'model-schema:Account')?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  // The old check matched the guessed name as a substring of the schema
  // source, so a column named `posts` (or a comment mentioning it) counted as
  // a table definition.
  it('warns when the model binds a table the schema does not declare, even if the guessed name appears in it', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-model-missing-table-')

    try {
      await writeModel(
        workspace.dir,
        'Post.ts',
        `import { defineModel } from '@guren/core'
import { articles } from '@/db/schema'
export class Post extends defineModel(articles) {}`,
      )
      await writeSchema(
        workspace.dir,
        `// the 'posts' table lives elsewhere
export const users = sqliteTable('users', {
  posts: integer('posts'),
})`,
      )

      const report = await runCheck({ cwd: workspace.dir })

      const schemaCheck = report.checks.find(c => c.key === 'model-schema:Post')
      expect(schemaCheck).toBeDefined()
      expect(schemaCheck!.status).toBe('warn')
      expect(schemaCheck!.message).toContain("'articles'")
      expect(schemaCheck!.suggestion).toContain('users')
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips the model-schema check when the model binds no readable table', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-model-no-binding-')

    try {
      await writeModel(workspace.dir, 'Post.ts', 'export class Post {}')
      await writeSchema(workspace.dir, `export const posts = sqliteTable('posts', {})`)

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some(c => c.key.startsWith('model-schema:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  // parseSchemaTables reports nothing for a missing or unparsable schema, and
  // "no tables to compare against" is not evidence the model is wrong.
  it('skips the model-schema check when the schema declares no readable tables', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-model-unreadable-schema-')

    try {
      await writeModel(
        workspace.dir,
        'Post.ts',
        `import { defineModel } from '@guren/core'
import { posts } from '@/db/schema'
export class Post extends defineModel(posts) {}`,
      )
      await writeSchema(workspace.dir, 'export const posts = sqliteTable(')

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.some(c => c.key.startsWith('model-schema:'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
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
    async function withSchema(
      files: Record<string, string>,
      options: Partial<RunCheckOptions> = {},
    ): Promise<CheckReport> {
      const workspace = await createTempWorkspace('guren-cli-check-timestamptz-')
      try {
        for (const [relPath, content] of Object.entries(files)) {
          await mkdir(join(workspace.dir, dirname(relPath)), { recursive: true })
          await writeFile(join(workspace.dir, relPath), content, 'utf8')
        }
        return await runCheck({ cwd: workspace.dir, ...options })
      } finally {
        await workspace.cleanup()
      }
    }

    const timestamptzFindings = (report: CheckReport) =>
      report.checks.filter((c) => c.key.startsWith('schema-timestamptz:'))

    it('flags Postgres timestamp columns declared without withTimezone', async () => {
      const report = await withSchema({
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
      const report = await withSchema({ 'db/schema.ts': PG_SCHEMA_FIXTURE })

      expect(timestamptzFindings(report)).toHaveLength(0)
    })

    // `{ withTimezone: false }` and omitting the option emit identical DDL, so
    // the explicit form is not a suppression mechanism.
    it('flags an explicit withTimezone: false the same as an omission', async () => {
      const report = await withSchema({
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
      const report = await withSchema({ 'db/schema.ts': MYSQL_SCHEMA_FIXTURE })

      expect(timestamptzFindings(report)).toHaveLength(0)
    })

    // One file can legally mix factories, so the verdict is per table.
    it('flags only the Postgres table in a mixed schema', async () => {
      const report = await withSchema({
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
      const report = await withSchema({
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
      const report = await withSchema({
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
      const report = await withSchema({
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
      const report = await withSchema({
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
      const report = await withSchema(
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
