import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { generateScreensSpec } from '../src/spec-screens'
import { SPEC_BANNER } from '../src/spec-generate'
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
    expect(lines[0]).toBe(SPEC_BANNER)
    expect(lines[1]).toBe('')
    expect(artifact.content.endsWith('\n')).toBe(true)
    expect(artifact.content.endsWith('\n\n')).toBe(false)
    expect(artifact.content).toContain('# Screens')
  })

  it('joins pages to their props and the routes that render them', async () => {
    const { content } = await generateScreensSpec(workspace.dir)

    expect(content).toContain('## Pages (2)')
    expect(content).toContain('| Page | Props | Routes |')

    const indexRow = content.split('\n').find((line) => line.startsWith('| posts/Index '))
    expect(indexRow).toBeDefined()
    expect(indexRow).toContain('posts: string[]')
    // Union types must not break the table structure.
    expect(indexRow).toContain("filter: 'all' \\| 'mine'")
    expect(indexRow).toContain('GET /posts → PostController.index')
    expect(indexRow).toContain('GET /posts/:id → PostController.show')

    const showRow = content.split('\n').find((line) => line.startsWith('| posts/Show '))
    expect(showRow).toContain('GET /posts → PostController.index')
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

  it('degrades to a page-only listing instead of throwing', async () => {
    const { content } = await generateScreensSpec(workspace.dir)

    // Controller-referenced pages keep their rows — with empty Routes cells —
    // rather than being misfiled as unrouted.
    expect(content).toContain('## Pages (2)')
    const indexRow = content.split('\n').find((line) => line.startsWith('| posts/Index '))
    expect(indexRow).toBe("| posts/Index | { posts: string[] filter: 'all' \\| 'mine' } |  |")

    expect(content).toContain('## Unrouted pages (1)')
    expect(content).toContain('- admin/Orphan')
  })
})
