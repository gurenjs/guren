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

  // A decorated class used to make the whole file unparseable, and arch-check
  // skips files it cannot parse — so a real boundary violation in a file using
  // `@Injectable`-style decorators was silently invisible to `check --arch`.
  it('sees a boundary violation in a file that uses decorators', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-decorators-')
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
        `import { PostController } from '../Http/Controllers/PostController'

@Injectable()
export class OrderService {
  @observable total = 0
  @log accessor entries = []

  constructor(@inject('Clock') private clock: unknown) {}

  @measure run() {
    return PostController
  }
}`,
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

describe('runArchCheck derived module rules (RFC 0002, zero-config)', () => {
  it('flags one module reaching into another module\'s internals', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-module-internals-')
    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/app/Models/Invoice.ts'), 'export class Invoice {}', 'utf8')
      await mkdir(join(workspace.dir, 'modules/inventory'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/inventory/index.ts'),
        `import { Invoice } from '../billing/app/Models/Invoice'\nexport const inventoryModule = {}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })

      const violation = results.find((r) => r.filePath === 'modules/inventory/index.ts')
      expect(violation).toBeDefined()
      expect(violation!.status).toBe('fail')
      expect(violation!.message).toContain("modules/billing's internals")
      expect(violation!.suggestion).toContain('modules/billing (its index.ts)')
    } finally {
      await workspace.cleanup()
    }
  })

  it('flags top-level app code reaching into a module\'s internals', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-toplevel-internals-')
    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/app/Models/Invoice.ts'), 'export class Invoice {}', 'utf8')
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/ReportController.ts'),
        `import { Invoice } from '../../../modules/billing/app/Models/Invoice'\nexport class ReportController {}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })

      const violation = results.find((r) => r.filePath === 'app/Http/Controllers/ReportController.ts')
      expect(violation).toBeDefined()
      expect(violation!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('allows importing a module\'s index.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-index-ok-')
    try {
      await mkdir(join(workspace.dir, 'modules/billing'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/index.ts'), 'export const billingModule = {}', 'utf8')
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        `import { billingModule } from '../modules/billing'\nexport const app = { modules: [billingModule] }`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })

      expect(results.some((r) => r.status === 'fail')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('allows importing a module\'s db/schema.ts (the make:module re-export pattern)', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-schema-ok-')
    try {
      await mkdir(join(workspace.dir, 'modules/billing/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/db/schema.ts'), 'export const invoices = {}', 'utf8')
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), `export * from '../modules/billing/db/schema'`, 'utf8')

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })

      expect(results.some((r) => r.status === 'fail')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('allows a file inside a module importing another file in the same module', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-same-module-ok-')
    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Http/Controllers'), { recursive: true })
      await mkdir(join(workspace.dir, 'modules/billing/app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/app/Models/Invoice.ts'), 'export class Invoice {}', 'utf8')
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Http/Controllers/InvoiceController.ts'),
        `import { Invoice } from '../../Models/Invoice'\nexport class InvoiceController {}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })

      expect(results.some((r) => r.status === 'fail')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns no results when modules/ is absent', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-no-modules-dir-')
    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post {}', 'utf8')

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })
      expect(results).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes with a summary when modules/ exists and has no violations', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-module-pass-')
    try {
      await mkdir(join(workspace.dir, 'modules/billing'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/index.ts'), 'export const billingModule = {}', 'utf8')

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })

      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('arch:module-summary')
      expect(results[0]!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('composes derived module rules with an explicit guren.arch.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-arch-compose-')
    try {
      // Explicit config targets app/Domain vs app/Http (unrelated to modules).
      await writeFile(join(workspace.dir, 'guren.arch.ts'), ARCH_CONFIG, 'utf8')
      await mkdir(join(workspace.dir, 'app/Domain'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Http/Controllers'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Http/Controllers/PostController.ts'), 'export class PostController {}', 'utf8')
      await writeFile(
        join(workspace.dir, 'app/Domain/OrderService.ts'),
        `import { PostController } from '../Http/Controllers/PostController'\nexport class OrderService {}`,
        'utf8',
      )

      // Separately, a module boundary violation.
      await mkdir(join(workspace.dir, 'modules/billing/app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/app/Models/Invoice.ts'), 'export class Invoice {}', 'utf8')
      await mkdir(join(workspace.dir, 'modules/inventory'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/inventory/index.ts'),
        `import { Invoice } from '../billing/app/Models/Invoice'\nexport const inventoryModule = {}`,
        'utf8',
      )

      const results = await runArchCheck({ cwd: workspace.dir, cache: new ParseCache() })

      expect(results.some((r) => r.filePath === 'app/Domain/OrderService.ts' && r.status === 'fail')).toBe(true)
      expect(results.some((r) => r.filePath === 'modules/inventory/index.ts' && r.status === 'fail')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })
})
