import { describe, expect, it } from 'bun:test'
import { extractPagePropKeysFromSource, extractPagePropsFromSource, pagePropMember, readPagePropMembers } from '../src/page-props-extractor'
import { parseSourceFile } from '../src/parse-cache'

describe('extractPagePropsFromSource', () => {
  it('extracts interface Props', () => {
    const source = `
interface Props {
  post: { id: number; title: string }
  comments: Comment[]
}
export default function Show({ post, comments }: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'posts/Show')
    expect(result.rawType).toContain('post: { id: number; title: string }')
    expect(result.rawType).toContain('comments: Comment[]')
  })

  it('extracts type Props alias', () => {
    const source = `
type Props = {
  user: User | null
  count: number
}
export default function Dashboard({ user, count }: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'Dashboard')
    expect(result.rawType).toContain('user: User | null')
    expect(result.rawType).toContain('count: number')
  })

  it('extracts export interface Props', () => {
    const source = `
export interface Props {
  items: string[]
}
export default function List({ items }: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'List')
    expect(result.rawType).toContain('items: string[]')
  })

  it('extracts inline type annotation on default export', () => {
    const source = `
export default function Show({ post }: { post: { id: number; title: string } }) { return null }
`
    const result = extractPagePropsFromSource(source, 'posts/Show')
    expect(result.rawType).toContain('post: { id: number; title: string }')
  })

  it('extracts generic types', () => {
    const source = `
interface Props {
  data: Array<{ id: number }>
  map: Map<string, number>
}
export default function Page({ data, map }: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'Page')
    expect(result.rawType).toContain('data: Array<{ id: number }>')
    expect(result.rawType).toContain('Map<string, number>')
  })

  it('collects type-only imports', () => {
    const source = `
import type { Post } from '../../types'
import { useState } from 'react'

interface Props {
  post: Post
}
export default function Show({ post }: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'posts/Show')
    expect(result.imports).toHaveLength(1)
    expect(result.imports[0]).toContain("import type { Post } from '../../types'")
  })

  it('returns null rawType when no Props found', () => {
    const source = `
export default function Page() { return null }
`
    const result = extractPagePropsFromSource(source, 'Page')
    expect(result.rawType).toBeNull()
  })

  it('handles union types in Props', () => {
    const source = `
interface Props {
  status: 'active' | 'inactive'
  data: string | number | null
}
export default function Page({ status, data }: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'Page')
    expect(result.rawType).toContain("status: 'active' | 'inactive'")
  })

  it('handles nested objects in Props', () => {
    const source = `
interface Props {
  pagination: {
    meta: { currentPage: number; lastPage: number }
    links: { prev: string | null; next: string | null }
  }
}
export default function Page({ pagination }: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'Page')
    expect(result.rawType).toContain('meta: { currentPage: number; lastPage: number }')
  })

  it('handles invalid syntax gracefully', () => {
    const result = extractPagePropsFromSource('this is not valid typescript {{{{', 'Bad')
    expect(result.rawType).toBeNull()
  })
})

describe('extractPagePropsFromSource with heritage clauses', () => {
  it('composes extends clauses with own members as an intersection', () => {
    const source = `
import type { PaginatedPageProps } from '@guren/core'
import type { TaskResourceData } from '../../../app/Http/Resources/TaskResource.js'

interface Props extends PaginatedPageProps<TaskResourceData> {
  filters: { q: string; status: string }
}

export default function TasksIndex(props: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'tasks/Index')
    expect(result.rawType).toBe(`PaginatedPageProps<TaskResourceData> & {
  filters: { q: string; status: string }
}`)
    expect(result.imports.some((statement) => statement.includes('PaginatedPageProps'))).toBe(true)
  })

  it('keeps empty-bodied interfaces that only extend a base type', () => {
    const source = `
import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '../../../app/Http/Resources/PostResource.js'

interface Props extends PaginatedPageProps<PostResourceData> {}

export default function PostsIndex(props: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'posts/Index')
    expect(result.rawType).toBe('PaginatedPageProps<PostResourceData> & {}')
  })

  it('supports multiple heritage clauses', () => {
    const source = `
interface Shared { appName: string }
interface Meta { title: string }
interface Props extends Shared, Meta {
  count: number
}
export default function Page(props: Props) { return null }
`
    const result = extractPagePropsFromSource(source, 'multi/Page')
    expect(result.rawType).toBe(`Shared & Meta & {
  count: number
}`)
    expect(result.localTypes).toHaveLength(2)
  })
})

describe('extractPagePropKeysFromSource', () => {
  it('should list the keys of a Props interface with optionality and type text', () => {
    const result = extractPagePropKeysFromSource(`
      import type { PostData } from '@/types'
      interface Props {
        posts: PostData[]
        filters?: {
          q: string
          tag?: string
        }
        'data-id': number
        onSelect(id: number): void
        untyped
      }
      export default function Index({ posts }: Props) { return null }
    `)

    expect(result).toEqual({
      status: 'keys',
      keys: [
        { name: 'posts', optional: false, type: 'PostData[]' },
        { name: 'filters', optional: true, type: '{ q: string tag?: string }' },
        { name: 'data-id', optional: false, type: 'number' },
        { name: 'onSelect', optional: false, type: '(id: number): void' },
        { name: 'untyped', optional: false },
      ],
    })
  })

  it('should list the keys of an exported inline object alias', () => {
    const result = extractPagePropKeysFromSource(`
      export type Props = { title: string; draft?: boolean }
      export default function Show(props: Props) { return null }
    `)

    expect(result).toEqual({
      status: 'keys',
      keys: [
        { name: 'title', optional: false, type: 'string' },
        { name: 'draft', optional: true, type: 'boolean' },
      ],
    })
  })

  it('should read an inline parameter annotation and one naming a same-file interface', () => {
    expect(extractPagePropKeysFromSource(`
      export default function Show({ title }: { title: string }) { return null }
    `)).toEqual({ status: 'keys', keys: [{ name: 'title', optional: false, type: 'string' }] })

    expect(extractPagePropKeysFromSource(`
      interface ShowProps { title: string }
      type Alias = ShowProps
      export default function Show({ title }: Alias) { return null }
    `)).toEqual({ status: 'keys', keys: [{ name: 'title', optional: false, type: 'string' }] })
  })

  it('should report an empty object type as zero keys, not as unreadable', () => {
    expect(extractPagePropKeysFromSource('interface Props {}\nexport default function P(_: Props) { return null }'))
      .toEqual({ status: 'keys', keys: [] })
  })

  it('should report a page with no props declaration as undeclared', () => {
    expect(extractPagePropKeysFromSource('export default function Home() { return null }'))
      .toEqual({ status: 'undeclared' })
  })

  const UNREADABLE: Array<[string, string]> = [
    ['an imported type', `import type { PageProps } from '@/types'\ntype Props = PageProps`],
    ['an intersection', `type Props = { a: string } & { b: string }`],
    ['a union', `type Props = { a: string } | { b: string }`],
    ['a generic reference', `type Props = Paginated<Post>`],
    ['a same-file generic declaration', `interface Box<T> { value: T }\ntype Props = Box`],
    ['a merged interface', `interface Props { a: string }\ninterface Props { b: number }`],
    ['a merged interface behind an alias', `interface Shape { a: string }\ninterface Shape { b: number }\ntype Props = Shape`],
    ['a generic Props declaration', `type Props<T = string> = { value: T }\nexport default function P(p: Props<number>) { return null }`],
    ['a qualified name', `type Props = Types.PageProps`],
    ['an interface with a heritage clause', `interface Base { a: string }\ninterface Props extends Base { b: string }`],
    ['an index signature', `interface Props { a: string; [key: string]: unknown }`],
    ['a computed key', `interface Props { [KEY]: string }`],
    ['a mapped type', `type Props = { [K in Keys]: string }`],
    ['a self-referring alias', `type A = B\ntype B = A\ntype Props = A`],
    ['an imported parameter annotation', `import type { PageProps } from '@/types'\nexport default function P(props: PageProps) { return null }`],
  ]

  for (const [label, source] of UNREADABLE) {
    it(`should report ${label} as unreadable, never as an empty key list`, () => {
      const result = extractPagePropKeysFromSource(source)

      expect(result.status).toBe('unreadable')
      expect(result).toHaveProperty('reason')
    })
  }

  it('should report a page that does not parse as unreadable', () => {
    expect(extractPagePropKeysFromSource('interface Props {{{').status).toBe('unreadable')
  })
})

describe('readPagePropMembers', () => {
  function member(source: string, name: string) {
    const ast = parseSourceFile(source, 'page.tsx')
    if (!ast) throw new Error('fixture does not parse')
    return pagePropMember(readPagePropMembers(ast, source), name)
  }

  it('reads a literal part of an intersection and leaves the rest open', () => {
    const source = `type Props = Shared & { posts?: Post[]; count: number }
export default function Index({ posts }: Props) { return null }
`
    expect(member(source, 'posts')).toEqual({ status: 'declared', name: 'posts', optional: true, acceptsUndefined: true, type: 'Post[]' })
    expect(member(source, 'count')).toEqual({ status: 'declared', name: 'count', optional: false, acceptsUndefined: false, type: 'number' })
    expect(member(source, 'other')).toEqual({ status: 'unreadable', reason: '`Shared` is intersected in, and may declare it' })
    expect(member('type Props = Shared\nexport default function Index(props: Props) { return null }\n', 'other'))
      .toEqual({ status: 'unreadable', reason: '`Shared` is not declared in the page file' })
  })

  it('treats unknown, any, void, an unannotated member, a parenthesised union and a same-file alias as admitting undefined', () => {
    const source = `type Posts = Post[] | undefined
type Loop = Loop
interface Props { a: unknown; b: any; c: void; d: (Post | undefined); e: Post | null; f(): void; g; h: Posts; i: Loop; j: Imported }
export default function Index(props: Props) { return null }
`
    for (const name of ['a', 'b', 'c', 'd', 'g', 'h']) expect(member(source, name)).toMatchObject({ status: 'declared', acceptsUndefined: true })
    expect(member(source, 'e')).toMatchObject({ status: 'declared', acceptsUndefined: false, type: 'Post | null' })
    expect(member(source, 'f')).toMatchObject({ status: 'declared', optional: false, acceptsUndefined: false, type: '(): void' })
    expect(member(source, 'i')).toMatchObject({ status: 'declared', acceptsUndefined: false })
    expect(member(source, 'j')).toMatchObject({ status: 'declared', acceptsUndefined: false })
  })

  it('is confident about an absent member only when the type declares every member', () => {
    const closed = `interface Props { posts: Post[] }
export default function Index({ posts }: Props) { return null }
`
    expect(member(closed, 'stats')).toEqual({ status: 'absent' })
    const open = `interface Props extends Base { posts: Post[] }
export default function Index({ posts }: Props) { return null }
`
    expect(member(open, 'posts')).toMatchObject({ status: 'declared', acceptsUndefined: false })
    expect(member(open, 'stats')).toEqual({ status: 'unreadable', reason: '`Props` extends another type, which may declare it' })
    expect(member('export default function Index(props) { return null }\n', 'stats')).toEqual({ status: 'undeclared' })
  })
})
