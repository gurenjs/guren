import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  describeInertiaPage,
  describeInertiaPagePropKeys,
  extractInertiaPageRefs,
  expectedInertiaPagePath,
  listInertiaPageIds,
  resolveInertiaPageFile,
} from '../src/inertia-pages'
import { createTempWorkspace, PAGE_COMPONENT_FIXTURE, writeWorkspaceFiles } from './helpers'

/** A workspace whose pages directory holds `names`, each a trivial component. */
async function workspaceWithPages(prefix: string, names: string[]) {
  const workspace = await createTempWorkspace(prefix)
  await writeWorkspaceFiles(
    workspace.dir,
    Object.fromEntries(names.map((name) => [`resources/js/pages/${name}`, PAGE_COMPONENT_FIXTURE])),
  )
  return workspace
}

describe('extractInertiaPageRefs', () => {
  it('extracts string-literal references', () => {
    const refs = extractInertiaPageRefs(`
      class PostController {
        index() { return this.inertia('posts/Index', { posts: [] }) }
      }
    `)

    expect(refs).toEqual([{ id: 'posts/Index', form: 'literal' }])
  })

  it('extracts typed-manifest references', () => {
    const refs = extractInertiaPageRefs(`
      class PostController {
        show() { return this.inertia(pages.posts.Show, { post }) }
      }
    `)

    expect(refs).toEqual([{ id: 'posts/Show', form: 'manifest' }])
  })

  it('supports bracket segments in manifest references', () => {
    const refs = extractInertiaPageRefs(`
      class AdminController {
        index() { return this.inertia(pages['sales-admin'].Index, {}) }
      }
    `)

    expect(refs).toEqual([{ id: 'sales-admin/Index', form: 'manifest' }])
  })

  it('deduplicates repeated references', () => {
    const refs = extractInertiaPageRefs(`
      class PostController {
        a() { return this.inertia('posts/Index') }
        b() { return this.inertia('posts/Index') }
      }
    `)

    expect(refs).toHaveLength(1)
  })
})

describe('expectedInertiaPagePath', () => {
  it('points at the conventional .tsx location', () => {
    expect(expectedInertiaPagePath('posts/Index')).toBe('resources/js/pages/posts/Index.tsx')
  })
})

describe('resolveInertiaPageFile', () => {
  it('resolves .tsx and .jsx pages', async () => {
    const workspace = await workspaceWithPages('guren-cli-page-resolve-', ['Home.tsx', 'Legacy.jsx'])
    try {
      expect(await resolveInertiaPageFile(workspace.dir, 'Home')).toBe('resources/js/pages/Home.tsx')
      expect(await resolveInertiaPageFile(workspace.dir, 'Legacy')).toBe('resources/js/pages/Legacy.jsx')
    } finally {
      await workspace.cleanup()
    }
  })

  it('prefers .tsx over a .jsx of the same id', async () => {
    const workspace = await workspaceWithPages('guren-cli-page-resolve-order-', ['Home.jsx', 'Home.tsx'])
    try {
      expect(await resolveInertiaPageFile(workspace.dir, 'Home')).toBe('resources/js/pages/Home.tsx')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not resolve a .ts or .js file, which codegen never registers', async () => {
    const workspace = await workspaceWithPages('guren-cli-page-resolve-unrenderable-', ['Plain.ts', 'Script.js'])
    try {
      expect(await resolveInertiaPageFile(workspace.dir, 'Plain')).toBeUndefined()
      expect(await resolveInertiaPageFile(workspace.dir, 'Script')).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('listInertiaPageIds', () => {
  it('lists only the renderable pages', async () => {
    const workspace = await workspaceWithPages('guren-cli-page-list-', [
      'Home.tsx',
      'Legacy.jsx',
      'Plain.ts',
      'Script.js',
      // The shared types directory is not a page, whatever the extension.
      'contracts/Shared.tsx',
    ])
    try {
      expect(await listInertiaPageIds(workspace.dir)).toEqual(['Home', 'Legacy'])
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('describeInertiaPagePropKeys', () => {
  const PAGE = `interface Props {
  posts: Array<{ id: number }>
  filters?: string
}
export default function Index({ posts }: Props) { return null }
`

  it('should resolve a page id to its prop keys and leave the props line unchanged', async () => {
    const workspace = await createTempWorkspace('guren-cli-page-prop-keys-')
    try {
      await mkdir(join(workspace.dir, 'resources/js/pages/posts'), { recursive: true })
      await writeFile(join(workspace.dir, 'resources/js/pages/posts/Index.tsx'), PAGE, 'utf8')

      expect(await describeInertiaPagePropKeys(workspace.dir, 'posts/Index')).toEqual({
        status: 'keys',
        keys: [
          { name: 'posts', optional: false, type: 'Array<{ id: number }>' },
          { name: 'filters', optional: true, type: 'string' },
        ],
      })
      expect(await describeInertiaPage(workspace.dir, 'posts/Index')).toEqual({
        id: 'posts/Index',
        filePath: 'resources/js/pages/posts/Index.tsx',
        props: '{ posts: Array<{ id: number }> filters?: string }',
      })
    } finally {
      await workspace.cleanup()
    }
  })

  it('should answer null for a page with no component file', async () => {
    const workspace = await createTempWorkspace('guren-cli-page-prop-keys-missing-')
    try {
      expect(await describeInertiaPagePropKeys(workspace.dir, 'posts/Missing')).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('should report an imported Props as unreadable', async () => {
    const workspace = await createTempWorkspace('guren-cli-page-prop-keys-imported-')
    try {
      await mkdir(join(workspace.dir, 'resources/js/pages'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'resources/js/pages/Home.tsx'),
        "import type { HomeProps } from './contracts/home'\ntype Props = HomeProps\nexport default function Home(_: Props) { return null }\n",
        'utf8',
      )

      expect((await describeInertiaPagePropKeys(workspace.dir, 'Home'))?.status).toBe('unreadable')
    } finally {
      await workspace.cleanup()
    }
  })
})
