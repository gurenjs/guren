import { useState, type FormEvent } from 'react'
import { Head, Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'
import { createApiClient, type ApiRoutes } from '@/.guren/api-client.gen'
import Layout from '../../components/Layout.js'

interface Props extends PaginatedPageProps<PostResourceData> {}

// posts.search is an HTTP QUERY route (RFC 10008): safe like GET, but the
// criteria travel in a JSON body — HTML forms and Inertia navigation cannot
// send it, so the page calls it through the generated typed client. The
// client types the request body from the schema bound to the route, and
// json() from the `resource` hint the route declares — both come from the
// route definition, so this file never restates the wire shape.
const api = createApiClient<ApiRoutes>({ baseUrl: '' })

export default function PostsIndex({ data, pagination }: Props) {
  const [keywords, setKeywords] = useState('')
  const [results, setResults] = useState<PostResourceData[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function search(event: FormEvent) {
    event.preventDefault()
    const terms = keywords.split(/\s+/).filter((term) => term.length > 0)
    if (terms.length === 0) {
      setResults(null)
      setError(null)
      return
    }

    setSearching(true)
    setError(null)
    try {
      const response = await api.request('posts.search', { body: { keywords: terms } })
      if (!response.ok) {
        setError('Search failed — try fewer or shorter keywords.')
        return
      }
      const payload = await response.json()
      setResults(payload.data)
    } catch {
      setError('Search failed — check your connection and try again.')
    } finally {
      setSearching(false)
    }
  }

  const posts = results ?? data

  return (
    <Layout>
      <Head title="Posts" />
      <section className="space-y-6">
        <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
          <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          Posts
        </h1>

        <form className="flex gap-2" onSubmit={search}>
          <input
            type="search"
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
            placeholder="Search posts…"
            className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
          />
          <button
            type="submit"
            disabled={searching}
            className="rounded-g-ctl border border-g-line-strong bg-g-panel px-4 py-2 text-sm font-bold text-g-text transition hover:border-g-muted disabled:cursor-not-allowed disabled:opacity-45"
          >
            Search
          </button>
        </form>

        {error !== null && <p className="text-sm text-g-danger">{error}</p>}

        {results !== null && (
          <p className="text-sm text-g-text-2">
            {results.length} {results.length === 1 ? 'result' : 'results'} ·{' '}
            <button
              type="button"
              onClick={() => {
                setKeywords('')
                setResults(null)
                setError(null)
              }}
              className="text-g-accent-text transition hover:underline"
            >
              Clear
            </button>
          </p>
        )}

        <div className="space-y-4">
          {posts.map((post) => (
            <article key={post.id} className="rounded-g-card border border-g-line bg-g-panel p-5 shadow-g-card">
              <Link
                href={route('posts.show', { id: post.id })}
                className="text-lg font-bold text-g-heading transition hover:text-g-accent-text"
              >
                {post.title}
              </Link>
              <p className="mt-2 text-sm text-g-text-2">{post.excerpt}</p>
              {post.author ? (
                <p className="mt-3 font-mono text-xs uppercase tracking-wide text-g-muted">by {post.author.name}</p>
              ) : null}
            </article>
          ))}
        </div>

        {results === null && pagination?.links?.pages && (
          <nav className="flex gap-2 font-mono text-sm">
            {pagination.links.pages.map((page) => (
              <Link
                key={page.page}
                href={page.url ?? '#'}
                className="rounded-g-ctl border border-g-line px-3 py-1 text-g-text-2 transition hover:border-g-line-strong hover:text-g-heading"
              >
                {page.page}
              </Link>
            ))}
          </nav>
        )}
      </section>
    </Layout>
  )
}
