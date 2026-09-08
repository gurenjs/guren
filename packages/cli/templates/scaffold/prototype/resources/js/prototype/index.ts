/**
 * The prototype fixture (RFC 0021). Under `vite --mode prototype` it answers
 * every Inertia visit in the browser, so `dist/prototype/` runs on a static
 * host with no server; on the server, routes registered with the `prototype`
 * handler answer from it until a controller replaces them. Each entry is keyed
 * by route name, typed from the route manifest and the page's Props, so a
 * renamed route or a changed Props interface fails the typecheck here.
 * `bunx guren make:feature <Entity> --prototype` appends entries.
 */
import { apiRoutes, definePrototype } from '@guren/inertia-client/prototype'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { routeManifest } from '@/.guren/routes.gen'

const PER_PAGE = 10

/** The `PaginatedPageProps` shape an index page expects, over an in-memory list. */
export function paginate<T>(items: T[], pageNumber: number, path: string) {
  const total = items.length
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE))
  const currentPage = Math.min(Math.max(1, pageNumber || 1), lastPage)
  const start = (currentPage - 1) * PER_PAGE
  const urlFor = (n: number) => (n === 1 ? path : `${path}?page=${n}`)

  return {
    data: items.slice(start, start + PER_PAGE),
    pagination: {
      meta: {
        currentPage,
        lastPage,
        perPage: PER_PAGE,
        total,
        from: total === 0 ? null : start + 1,
        to: total === 0 ? null : Math.min(start + PER_PAGE, total),
      },
      links: {
        first: urlFor(1),
        last: urlFor(lastPage),
        prev: currentPage > 1 ? urlFor(currentPage - 1) : null,
        next: currentPage < lastPage ? urlFor(currentPage + 1) : null,
        pages: Array.from({ length: lastPage }, (_, index) => ({
          page: index + 1,
          url: urlFor(index + 1),
          active: index + 1 === currentPage,
        })),
      },
    },
  }
}

export default definePrototype({
  manifest: routeManifest,
  api: apiRoutes<ApiRoutes>(),

  // Props every page carries under its own. The demo author keeps guarded
  // screens reachable in the walkthrough; set `user: null` to walk it as a guest.
  shared: {
    auth: { user: { id: 1, name: 'Demo User', email: 'demo@example.com' } },
  },

  // Seed data, persisted in the tab's sessionStorage; `?prototype.reset=1` on
  // any URL starts over. `make:feature --prototype` adds a collection per entity.
  state: () => ({
  }),

  // One entry per route name: `({ state, params, query, body, page, redirect,
  // errors, notFound }) => ...`. A named GET route with no entry opens the
  // 404 dialog in the prototype; `bunx guren check --prototype` lists them.
  routes: {
  },
})
