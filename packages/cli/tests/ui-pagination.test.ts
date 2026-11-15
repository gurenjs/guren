import { describe, expect, it } from 'bun:test'
import { Link } from '@inertiajs/react'
import type { ReactElement, ReactNode } from 'react'
import { Pagination, type PaginationLinksLike, type PaginationProps } from '../templates/scaffold/ui/resources/js/components/ui/Pagination'

function links(current: number, last: number, withUrls = true): PaginationLinksLike {
  const url = (page: number) => (withUrls ? `/posts?page=${page}` : null)
  return {
    prev: current > 1 ? url(current - 1) : null,
    next: current < last ? url(current + 1) : null,
    pages: Array.from({ length: last }, (_, index) => ({ page: index + 1, url: url(index + 1), active: index + 1 === current })),
  }
}

interface Item {
  link: boolean
  href?: string
  text: string
  current: boolean
}

// Pagination holds no hooks, so calling it gives the element tree without a renderer.
function items(props: PaginationProps): Item[] {
  const nav = Pagination(props) as ReactElement<{ children: ReactNode[] }>
  return nav.props.children.flat().map((child) => {
    const element = child as ReactElement<{ href?: string; children: ReactNode; 'aria-current'?: string }>
    return {
      link: element.type === Link,
      ...(element.props.href ? { href: element.props.href } : {}),
      text: String(element.props.children),
      current: element.props['aria-current'] === 'page',
    }
  })
}

/** The page numbers and gaps between Previous and Next. */
const numbers = (current: number, last: number, siblings?: number): string[] =>
  items({ links: links(current, last), ...(siblings === undefined ? {} : { siblings }) }).slice(1, -1).map((item) => item.text)

describe('Pagination', () => {
  it('should render nothing for a single page', () => {
    expect(Pagination({ links: links(1, 1) })).toBeNull()
  })

  it('should list every page when no run is long enough to collapse', () => {
    expect(numbers(1, 3)).toEqual(['1', '2', '3'])
    expect(numbers(4, 7)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  })

  it('should collapse the runs away from the current page into gaps', () => {
    expect(numbers(6, 12)).toEqual(['1', '…', '5', '6', '7', '…', '12'])
    expect(numbers(1, 12)).toEqual(['1', '2', '…', '12'])
    expect(numbers(12, 12)).toEqual(['1', '…', '11', '12'])
  })

  it('should show the one page a gap would hide', () => {
    expect(numbers(4, 12)).toEqual(['1', '2', '3', '4', '5', '…', '12'])
  })

  it('should widen the run around the current page by siblings', () => {
    expect(numbers(6, 12, 2)).toEqual(['1', '…', '4', '5', '6', '7', '8', '…', '12'])
  })

  it('should link previous, next and every other page, and mark the current one', () => {
    expect(items({ links: links(2, 3) })).toEqual([
      { link: true, href: '/posts?page=1', text: 'Previous', current: false },
      { link: true, href: '/posts?page=1', text: '1', current: false },
      { link: false, text: '2', current: true },
      { link: true, href: '/posts?page=3', text: '3', current: false },
      { link: true, href: '/posts?page=3', text: 'Next', current: false },
    ])
  })

  it('should not link a page or a step that has no URL', () => {
    expect(items({ links: links(1, 2, false) }).map(({ link, text }) => [link, text])).toEqual([
      [false, 'Previous'],
      [false, '1'],
      [false, '2'],
      [false, 'Next'],
    ])
  })

  it('should take its labels from props', () => {
    const props: PaginationProps = { links: links(1, 2), previousLabel: '前へ', nextLabel: '次へ', 'aria-label': 'ページ' }
    expect((Pagination(props) as ReactElement<{ 'aria-label': string }>).props['aria-label']).toBe('ページ')
    expect(items(props).map((item) => item.text)).toEqual(['前へ', '1', '2', '次へ'])
  })
})
