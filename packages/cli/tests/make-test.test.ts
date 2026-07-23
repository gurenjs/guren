import { describe, expect, it } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import { detectRunner, makeTest } from '../src/make-test'

describe('makeTest', () => {
  it('creates a test file using the provided runner', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-')
    try {
      const result = await makeTest('auth/login', { runner: 'bun' })

      expect(result).toContain('tests/auth/Login.test.ts')
      const content = await readFile(result, 'utf8')
      expect(content).toContain("from 'bun:test'")
      expect(content).toContain("describe('Login'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('throws when the test name is empty', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-empty-')
    try {
      await expect(makeTest('   ')).rejects.toThrow('Test name is required')
    } finally {
      await workspace.cleanup()
    }
  })

  it('defaults to bun:test when the project has no vitest dependency or config', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-default-')
    try {
      await writeFile(join(workspace.dir, 'package.json'), JSON.stringify({ name: 'app', devDependencies: {} }))

      const result = await makeTest('widget')

      const content = await readFile(result, 'utf8')
      expect(content).toContain("from 'bun:test'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects vitest when it is listed in package.json', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-vitest-pkg-')
    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'app', devDependencies: { vitest: '^2.0.0' } }),
      )

      const result = await makeTest('widget')

      const content = await readFile(result, 'utf8')
      expect(content).toContain("from 'vitest'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects vitest when a vitest config file is present', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-vitest-config-')
    try {
      await writeFile(join(workspace.dir, 'vitest.config.ts'), 'export default {}\n')

      const result = await makeTest('widget')

      const content = await readFile(result, 'utf8')
      expect(content).toContain("from 'vitest'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('prefers an explicit --runner over auto-detection', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-explicit-runner-')
    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'app', devDependencies: { vitest: '^2.0.0' } }),
      )

      const result = await makeTest('widget', { runner: 'bun' })

      const content = await readFile(result, 'utf8')
      expect(content).toContain("from 'bun:test'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds a controller test into tests/controllers with a Controller suffix', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-controller-')
    try {
      const result = await makeTest('Post', { runner: 'bun', controller: true })

      expect(result).toContain('tests/controllers/PostController.test.ts')
      const content = await readFile(result, 'utf8')
      expect(content).toContain("describe('PostController'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not double-append Controller when the name already has the suffix', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-controller-suffix-')
    try {
      const result = await makeTest('PostController', { runner: 'bun', controller: true })

      expect(result).toContain('tests/controllers/PostController.test.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds under modules/<name>/tests/ when root is set (--module)', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-module-')
    try {
      const result = await makeTest('auth/login', { runner: 'bun', root: 'billing' })
      expect(result).toContain('modules/billing/tests/auth/Login.test.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds a module controller test under modules/<name>/tests/controllers/', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-module-controller-')
    try {
      const result = await makeTest('Invoice', { runner: 'bun', controller: true, root: 'billing' })
      expect(result).toContain('modules/billing/tests/controllers/InvoiceController.test.ts')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('detectRunner', () => {
  it('returns bun when no vitest signal is present', async () => {
    const workspace = await createTempWorkspace('guren-cli-detect-runner-bun-')
    try {
      const runner = await detectRunner(workspace.dir)
      expect(runner).toBe('bun')
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns vitest when package.json lists it as a dependency', async () => {
    const workspace = await createTempWorkspace('guren-cli-detect-runner-dep-')
    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'app', dependencies: { vitest: '^2.0.0' } }),
      )

      const runner = await detectRunner(workspace.dir)
      expect(runner).toBe('vitest')
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns bun when package.json is malformed', async () => {
    const workspace = await createTempWorkspace('guren-cli-detect-runner-malformed-')
    try {
      await writeFile(join(workspace.dir, 'package.json'), '{ not valid json')

      const runner = await detectRunner(workspace.dir)
      expect(runner).toBe('bun')
    } finally {
      await workspace.cleanup()
    }
  })
})
