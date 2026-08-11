import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { generateScreensSpec } from '../src/spec-screens'
import { SPEC_BANNER } from '../src/spec-artifact'
import { createTempWorkspace, type TempWorkspace } from './helpers'

async function writeScreensFixture(dir: string, options: { routes: boolean }): Promise<void> {
  await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
  await mkdir(join(dir, 'resources/js/pages/posts'), { recursive: true })
  await mkdir(join(dir, 'resources/js/pages/admin'), { recursive: true })
  await mkdir(join(dir, 'resources/js/pages/contracts'), { recursive: true })
  await writeFile(join(dir, 'package.json'), '{}', 'utf8')

  if (options.routes) {
    await mkdir(join(dir, 'routes'), { recursive: true })
    await writeFile(
      join(dir, 'routes/web.ts'),
      `import type { Router } from '@guren/core'

class PostController {
  index() {}
  show() {}
}

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index'] as any).name('posts.index')
  router.get('/posts/:id', [PostController, 'show'] as any).name('posts.show')
  router.get('/about', () => new Response('ok')).name('about')
}
`,
      'utf8',
    )
  }

  await writeFile(
    join(dir, 'app/Http/Controllers/PostController.ts'),
    `export class PostController {
  async index() {
    return this.inertia('posts/Index', { posts: [] })
  }

  async show() {
    return this.inertia(pages.posts.Show, { post: null })
  }
}
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'resources/js/pages/posts/Index.tsx'),
    `interface Props {
  posts: string[]
  filter: 'all' | 'mine'
}

export default function Index({ posts }: Props) {
  return null
}
`,
    'utf8',
  )

  await writeFile(
    join(dir, 'resources/js/pages/posts/Show.tsx'),
    'export default function Show() { return null }\n',
    'utf8',
  )

  // On disk but referenced by no controller.
  await writeFile(
    join(dir, 'resources/js/pages/admin/Orphan.tsx'),
    'export default function Orphan() { return null }\n',
    'utf8',
  )

  // Shared prop contracts are not routable pages.
  await writeFile(
    join(dir, 'resources/js/pages/contracts/Shared.ts'),
    'export type Shared = { ok: boolean }\n',
    'utf8',
  )
}

describe('screens spec', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-screens-')
    await writeScreensFixture(workspace.dir, { routes: true })
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('emits screens.md with the banner, a blank line, and a single trailing newline', async () => {
    const artifact = await generateScreensSpec(workspace.dir)

    expect(artifact.fileName).toBe('screens.md')
    const lines = artifact.content.split('\n')
    expect(lines[0]).toBe('---')
    expect(lines[1]).toBe('type: spec')
    expect(lines).toContain(SPEC_BANNER)
    expect(artifact.content.endsWith('\n')).toBe(true)
    expect(artifact.content.endsWith('\n\n')).toBe(false)
    expect(artifact.content).toContain('# Screens')
    expect(artifact.degraded).toBeUndefined()
  })

  it('joins each page to the routes of the action that renders it, not the whole controller', async () => {
    const { content } = await generateScreensSpec(workspace.dir)

    expect(content).toContain('## Pages (2)')
    expect(content).toContain('| Page | Props | Routes |')

    const indexRow = content.split('\n').find((line) => line.startsWith('| posts/Index '))
    expect(indexRow).toBeDefined()
    expect(indexRow).toContain('posts: string[]')
    // Union types must not break the table structure.
    expect(indexRow).toContain("filter: 'all' \\| 'mine'")
    expect(indexRow).toContain('GET /posts → PostController.index')
    // `show`'s route belongs to `posts/Show` alone.
    expect(indexRow).not.toContain('/posts/:id')

    const showRow = content.split('\n').find((line) => line.startsWith('| posts/Show '))
    expect(showRow).toContain('GET /posts/:id → PostController.show')
    expect(showRow).not.toContain('GET /posts →')
  })

  it('lists pages on disk that no controller references, excluding contracts', async () => {
    const { content } = await generateScreensSpec(workspace.dir)

    expect(content).toContain('## Unrouted pages (1)')
    expect(content).toContain('- admin/Orphan')
    expect(content).not.toContain('contracts/Shared')
  })

  it('contains no absolute paths', async () => {
    const { content } = await generateScreensSpec(workspace.dir)

    expect(content).not.toContain(workspace.dir)
    expect(content).not.toContain('/private/')
  })

  it('renders an explicit routes file as an app-root-relative path', async () => {
    const { content } = await generateScreensSpec(workspace.dir, join(workspace.dir, 'routes/web.ts'))

    expect(content).toContain('Derived from `routes/web.ts`')
    expect(content).not.toContain(workspace.dir)
  })

  it('is byte-identical across regeneration', async () => {
    const first = await generateScreensSpec(workspace.dir)
    const second = await generateScreensSpec(workspace.dir)

    expect(second.content).toBe(first.content)
  })
})

describe('screens spec (routes file missing)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-screens-noroutes-')
    await writeScreensFixture(workspace.dir, { routes: false })
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('renders a page-only listing without flagging the artifact degraded', async () => {
    const artifact = await generateScreensSpec(workspace.dir)

    // An app with no routes file is a legitimate shape, so the document is
    // real content the drift gate may compare.
    expect(artifact.degraded).toBeUndefined()

    // Controller-referenced pages keep their rows — with empty Routes cells —
    // rather than being misfiled as unrouted.
    expect(artifact.content).toContain('## Pages (2)')
    const indexRow = artifact.content.split('\n').find((line) => line.startsWith('| posts/Index '))
    expect(indexRow).toBe("| posts/Index | { posts: string[] filter: 'all' \\| 'mine' } |  |")

    expect(artifact.content).toContain('## Unrouted pages (1)')
    expect(artifact.content).toContain('- admin/Orphan')
  })
})

describe('screens spec (routes file fails to load)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-screens-badroutes-')
    await writeScreensFixture(workspace.dir, { routes: false })
    await mkdir(join(workspace.dir, 'routes'), { recursive: true })
    // Imports fine, but exports no route registrar — `loadRouteDefinitions`
    // throws, which is not the same as having no routes.
    await writeFile(
      join(workspace.dir, 'routes/web.ts'),
      'export const notARegistrar = 1\n',
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('flags the artifact degraded so it is never written or compared', async () => {
    const artifact = await generateScreensSpec(workspace.dir)

    expect(artifact.degraded).toBeDefined()
    expect(artifact.degraded).toContain('route graph failed to load')

    // The document still renders, it just must not be trusted as in-sync.
    expect(artifact.content).toContain('## Pages (2)')
  })
})

describe('screens spec (page referenced outside any action)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-screens-outside-')
    const dir = workspace.dir

    await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
    await mkdir(join(dir, 'resources/js/pages/legacy'), { recursive: true })
    await mkdir(join(dir, 'routes'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')

    await writeFile(
      join(dir, 'routes/web.ts'),
      `import type { Router } from '@guren/core'

class LegacyController {
  index() {}
}

export function registerWebRoutes(router: Router): void {
  router.get('/legacy', [LegacyController, 'index'] as any).name('legacy.index')
}
`,
      'utf8',
    )

    await writeFile(
      join(dir, 'app/Http/Controllers/LegacyController.ts'),
      `export class LegacyController {
  async index() {
    return this.inertia('legacy/Index', {})
  }
}

// Rendered from a helper rather than an action — no route can be attributed,
// and no component exists for it on disk.
export const renderMissing = function (this: any) {
  return this.inertia('legacy/Missing', {})
}
`,
      'utf8',
    )

    await writeFile(
      join(dir, 'resources/js/pages/legacy/Index.tsx'),
      'export default function Index() { return null }\n',
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('keeps a row with an empty Routes cell and marks the missing component', async () => {
    const { content } = await generateScreensSpec(workspace.dir)

    expect(content).toContain('## Pages (2)')

    const indexRow = content.split('\n').find((line) => line.startsWith('| legacy/Index '))
    expect(indexRow).toBe('| legacy/Index |  | GET /legacy → LegacyController.index |')

    const missingRow = content.split('\n').find((line) => line.startsWith('| legacy/Missing '))
    expect(missingRow).toBe('| legacy/Missing (component file missing) |  |  |')

    // A page with no route is still a page, not an unrouted component on disk.
    expect(content).not.toContain('## Unrouted pages')
  })
})

describe('screens spec (module routes directory)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-screens-module-routes-dir-')
    const dir = workspace.dir
    await writeScreensFixture(dir, { routes: true })

    // The shape `make:route Invoice --module billing` scaffolds: the route
    // definitions live under modules/billing/routes/, reached only through
    // the module's registrar entry.
    await mkdir(join(dir, 'modules/billing/routes'), { recursive: true })
    await mkdir(join(dir, 'modules/billing/app/Http/Controllers'), { recursive: true })

    await writeFile(
      join(dir, 'modules/billing/index.ts'),
      `import { registerBillingRoutes } from './routes'

export default {
  name: 'billing',
  providers: [],
  routes: registerBillingRoutes,
}
`,
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/billing/routes.ts'),
      `import type { Router } from '@guren/core'
import { registerInvoiceRoutes } from './routes/invoice'

export function registerBillingRoutes(router: Router): void {
  registerInvoiceRoutes(router)
}
`,
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/billing/routes/invoice.ts'),
      `import type { Router } from '@guren/core'

class InvoiceController {
  index() {}
}

export function registerInvoiceRoutes(router: Router): void {
  router.get('/billing/invoices', [InvoiceController, 'index'] as any).name('billing.invoices.index')
}
`,
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/billing/app/Http/Controllers/InvoiceController.ts'),
      `export class InvoiceController {
  async index() {
    return this.inertia('billing/Invoices', { invoices: [] })
  }
}
`,
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('derives routes from files under modules/*/routes/, so those files are a screens.md source', async () => {
    const { content } = await generateScreensSpec(workspace.dir)

    // The route reaching the document exists only in
    // modules/billing/routes/invoice.ts — proof that a change to a module
    // routes-directory file can change screens.md, which is what the
    // matching source pattern in SPEC_VIEWS promises `check --spec --changed`.
    const row = content.split('\n').find((line) => line.startsWith('| billing/Invoices '))
    expect(row).toBeDefined()
    expect(row).toContain('GET /billing/invoices → InvoiceController.index')
  })
})
