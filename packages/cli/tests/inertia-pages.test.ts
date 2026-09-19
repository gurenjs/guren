import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  describeInertiaPage,
  describeInertiaPagePropKeys,
  extractInertiaPageRefs,
  expectedInertiaPagePath,
} from '../src/inertia-pages'
import { createTempWorkspace } from './helpers'

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
