import { describe, expect, it } from 'bun:test'
import { extractPagePropsFromSource } from '../src/page-props-extractor'

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
