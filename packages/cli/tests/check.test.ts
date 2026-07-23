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
})
