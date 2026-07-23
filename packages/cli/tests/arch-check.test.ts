import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runArchCheck } from '../src/arch-check'
import { ParseCache } from '../src/parse-cache'
import { createTempWorkspace } from './helpers'

// Config fixtures export a plain object rather than importing defineArchRules
// (an identity function the loader doesn't require) — the workspace lives in
// a temp directory, so a relative import back into the package source isn't
// resolvable from there.
const ARCH_CONFIG = `
export default {
  layers: {
    domain: 'app/Domain/**',
    http: 'app/Http/**',
  },
  rules: [
    { from: 'domain', disallow: ['http'] },
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
}
`

describe('runArchCheck', () => {
  it('returns no results when guren.arch.ts is absent', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-none-')
    try {
      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      expect(results).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when guren.arch.ts fails to load', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-loaderror-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), 'export default { rules: "not-an-array" }', 'utf8')

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      expect(results).toHaveLength(1)
      expect(results[0]!.status).toBe('warn')
      expect(results[0]!.key).toBe('arch:config')
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when a domain-layer file imports from the http layer', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-violation-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
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

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      const violation = results.find((r) => r.filePath === 'app/Domain/OrderService.ts')
      expect(violation).toBeDefined()
      expect(violation!.status).toBe('fail')
      expect(violation!.message).toContain('disallowed layer')
    } finally {
      await workspace.cleanup()
    }
  })

  it('flags a disallowed package import from a layer', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-pkg-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `import { eq } from 'drizzle-orm'\nexport class PostController {}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      const violation = results.find((r) => r.filePath === 'app/Http/Controllers/PostController.ts')
      expect(violation).toBeDefined()
      expect(violation!.status).toBe('fail')
      expect(violation!.message).toContain("disallowed package 'drizzle-orm'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('respects a rule severity of warn', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-warn-severity-')
    try {
      await writeFile(
        join(workspace.dir, 'guren.arch.ts'),
        `
export default {
  layers: { domain: 'app/Domain/**', http: 'app/Http/**' },
  rules: [{ from: 'domain', disallow: ['http'], severity: 'warn' }],
}
`,
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

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      const violation = results.find((r) => r.filePath === 'app/Domain/OrderService.ts')
      expect(violation).toBeDefined()
      expect(violation!.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns (not fails) on an unresolvable relative import', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-unresolved-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Domain/OrderService.ts'),
        `import { Missing } from './DoesNotExist'\nexport class OrderService {}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      expect(results).toHaveLength(1)
      expect(results[0]!.status).toBe('warn')
      expect(results[0]!.message).toContain('could not be resolved')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes with a summary when no violations are found', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-pass-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Domain/OrderService.ts'), `export class OrderService {}`, 'utf8')

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      expect(results).toHaveLength(1)
      expect(results[0]!.status).toBe('pass')
      expect(results[0]!.key).toBe('arch:summary')
    } finally {
      await workspace.cleanup()
    }
  })

  it('honors an inline glob for `from` instead of a named layer', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-inline-glob-')
    try {
      await writeFile(
        join(workspace.dir, 'guren.arch.ts'),
        `
export default {
  rules: [{ from: 'app/Domain/**', disallowPackages: ['drizzle-orm'] }],
}
`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Domain/OrderService.ts'),
        `import { eq } from 'drizzle-orm'\nexport class OrderService {}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      const violation = results.find((r) => r.filePath === 'app/Domain/OrderService.ts')
      expect(violation).toBeDefined()
      expect(violation!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves a .js-extension import to its .ts source (NodeNext/bundler-style specifiers)', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-js-ext-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `export class PostController {}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Domain/OrderService.ts'),
        // '.js' specifier, but only OrderService.ts/PostController.ts exist on disk.
        `import { PostController } from '../Http/Controllers/PostController.js'\nexport class OrderService {}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      const violation = results.find((r) => r.filePath === 'app/Domain/OrderService.ts')
      expect(violation).toBeDefined()
      expect(violation!.status).toBe('fail')
      expect(violation!.message).toContain('disallowed layer')
      expect(results.some((r) => r.status === 'warn')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not flag a whole-declaration type-only import as a boundary violation', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-type-only-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `export interface PostDto { id: number }\nexport class PostController {}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Domain/OrderService.ts'),
        `import type { PostDto } from '../Http/Controllers/PostController'\nexport class OrderService {\n  dto?: PostDto\n}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      expect(results).toHaveLength(1)
      expect(results[0]!.status).toBe('pass') // summary — no violation for a type-only import
    } finally {
      await workspace.cleanup()
    }
  })

  it('still flags a mixed declaration where a non-type binding crosses the boundary', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-type-mixed-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        `export interface PostDto { id: number }\nexport class PostController {}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Domain/OrderService.ts'),
        `import { type PostDto, PostController } from '../Http/Controllers/PostController'\nexport class OrderService {\n  dto?: PostDto\n  ctrl = PostController\n}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      const violation = results.find((r) => r.filePath === 'app/Domain/OrderService.ts')
      expect(violation).toBeDefined()
      expect(violation!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('restricts checked files to the provided changedFiles set', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-changed-')
    try {
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
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

      const results = await runArchCheck({
        cwd: workspace.dir,
        cache: new ParseCache(),
        changedFiles: new Set(['app/Http/Controllers/PostController.ts']),
      })
      // OrderService.ts (the violating file) wasn't in the changed set, so it's never scanned.
      expect(results.some((r) => r.filePath === 'app/Domain/OrderService.ts')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })
})
