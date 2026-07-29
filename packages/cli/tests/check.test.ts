import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runCheck } from '../src/check'
import { createTempWorkspace } from './helpers'

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
      await writeFile(join(workspace.dir, 'modules/billing/app/Models/Invoice.ts'), 'export class Invoice {}', 'utf8')
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
})
