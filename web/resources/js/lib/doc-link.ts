export interface AnchorLike {
  /** The attribute as written, not the resolved `anchor.href`. */
  href: string | null
  target: string
  download: boolean
}

export interface CurrentLocation {
  origin: string
  pathname: string
}

// `/docs/search` answers JSON and `.md` is the raw mirror: neither is an Inertia page.
const DOC_PAGE = /^\/docs(?:\/(?:ja|[a-z0-9-]+\/[a-z0-9-]+|ja\/[a-z0-9-]+\/[a-z0-9-]+))?\/?$/u

/**
 * The path to visit client-side for a link in rendered markdown, or undefined
 * when the browser should follow it: another origin, a new tab, a download, a
 * non-page route, or a fragment on the page already open.
 */
export function clientVisitHref(anchor: AnchorLike, current: CurrentLocation): string | undefined {
  if (!anchor.href || anchor.download || (anchor.target && anchor.target !== '_self')) return undefined

  let url: URL
  try {
    url = new URL(anchor.href, `${current.origin}${current.pathname}`)
  } catch {
    return undefined
  }

  if (url.origin !== current.origin || !DOC_PAGE.test(url.pathname)) return undefined
  if (url.pathname === current.pathname && url.hash) return undefined

  return `${url.pathname}${url.search}${url.hash}`
}
