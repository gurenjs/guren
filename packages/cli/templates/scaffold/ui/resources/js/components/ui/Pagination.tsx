// guren-ui: Pagination v1. `guren upgrade` replaces this file only while it is unedited.
import { Link } from '@inertiajs/react'
import type { HTMLAttributes } from 'react'

/** The `links` a paginator sends (`pagination.links` of `PaginatedPageProps`), read by shape. */
export interface PaginationLinksLike {
  prev: string | null
  next: string | null
  pages: readonly { page: number; url: string | null; active: boolean }[]
}

type PaginationItem = number | 'gap'

/**
 * The first and last page, `siblings` pages either side of the current one, and a gap between runs.
 * Not exported: a component file that exports a function besides its components loses Vite's Fast Refresh.
 */
function paginationItems(current: number, last: number, siblings = 1): PaginationItem[] {
  const shown = new Set([1, last])
  for (let page = current - siblings; page <= current + siblings; page++) {
    if (page >= 1 && page <= last) shown.add(page)
  }
  const items: PaginationItem[] = []
  let previous = 0
  for (const page of [...shown].sort((a, b) => a - b)) {
    // A gap of one page shows that page: "1 … 3" hides no more than "1 2 3" takes.
    if (page - previous === 2) items.push(previous + 1)
    else if (page - previous > 2) items.push('gap')
    items.push(page)
    previous = page
  }
  return items
}

const LINK = 'rounded-g-ctl border border-g-line px-3 py-1 text-g-text-2 transition hover:border-g-line-strong hover:text-g-heading'
// A tint, not the accent fill: the page's one fill is its primary action.
const CURRENT = 'rounded-g-ctl border border-g-accent-text bg-g-accent-tint px-3 py-1 font-bold text-g-accent-text'
const DISABLED = 'rounded-g-ctl border border-g-line px-3 py-1 text-g-muted'

export interface PaginationProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  links: PaginationLinksLike
  /** Pages shown either side of the current one before a gap. */
  siblings?: number
  previousLabel?: string
  nextLabel?: string
}

/** Previous, the page numbers and next as Inertia links; renders nothing for a single page. */
export function Pagination({
  links,
  siblings = 1,
  previousLabel = 'Previous',
  nextLabel = 'Next',
  className,
  'aria-label': label = 'Pagination',
  ...props
}: PaginationProps) {
  if (links.pages.length <= 1) return null
  const byNumber = new Map(links.pages.map((page) => [page.page, page]))
  const current = links.pages.find((page) => page.active)?.page ?? 1
  const last = links.pages.at(-1)?.page ?? current

  return (
    <nav aria-label={label} className={['flex flex-wrap items-center gap-2 font-mono text-sm', className].filter(Boolean).join(' ')} {...props}>
      {links.prev ? <Link href={links.prev} className={LINK}>{previousLabel}</Link> : <span aria-disabled="true" className={DISABLED}>{previousLabel}</span>}
      {paginationItems(current, last, siblings).map((item, index) => {
        if (item === 'gap') return <span key={`gap-${index}`} aria-hidden="true" className="px-1 text-g-muted">…</span>
        const url = byNumber.get(item)?.url
        if (item === current) return <span key={item} aria-current="page" className={CURRENT}>{item}</span>
        return url ? <Link key={item} href={url} className={LINK}>{item}</Link> : <span key={item} className={DISABLED}>{item}</span>
      })}
      {links.next ? <Link href={links.next} className={LINK}>{nextLabel}</Link> : <span aria-disabled="true" className={DISABLED}>{nextLabel}</span>}
    </nav>
  )
}
