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
        <h1 className="text-3xl font-semibold text-emerald-300">Posts</h1>

        <form className="flex gap-2" onSubmit={search}>
          <input
            type="search"
            value={keywords}
            onChange={(event) => setKeywords(event.target.value)}
            placeholder="Search posts…"
            className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring"
          />
          <button
            type="submit"
            disabled={searching}
            className="rounded border border-emerald-500 px-4 py-2 text-sm text-emerald-200 transition hover:bg-emerald-500/10 disabled:opacity-50"
          >
            Search
          </button>
        </form>

        {error !== null && <p className="text-sm text-rose-400">{error}</p>}

        {results !== null && (
          <p className="text-sm text-slate-400">
            {results.length} {results.length === 1 ? 'result' : 'results'} ·{' '}
            <button
              type="button"
              onClick={() => {
                setKeywords('')
                setResults(null)
                setError(null)
              }}
              className="text-emerald-300 transition hover:text-emerald-200"
            >
              Clear
            </button>
          </p>
        )}

        <div className="space-y-4">
          {posts.map((post) => (
            <article key={post.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
              <Link
                href={route('posts.show', { id: post.id })}
                className="text-lg font-medium text-slate-100 transition hover:text-emerald-200"
              >
                {post.title}
              </Link>
              <p className="mt-2 text-sm text-slate-400">{post.excerpt}</p>
              {post.author ? (
                <p className="mt-3 text-xs uppercase tracking-wide text-slate-500">by {post.author.name}</p>
              ) : null}
            </article>
          ))}
        </div>

        {results === null && pagination?.links?.pages && (
          <nav className="flex gap-2">
            {pagination.links.pages.map((page) => (
              <Link
                key={page.page}
                href={page.url ?? '#'}
                className="rounded border border-slate-800 px-3 py-1 text-sm text-slate-300 transition hover:border-emerald-500 hover:text-emerald-200"
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
