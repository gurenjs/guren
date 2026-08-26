import { Link, usePage } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props extends PaginatedPageProps<PostResourceData> {}

export default function Index({ data: posts, pagination }: Props) {
  const { props } = usePage<{ auth?: { user?: Record<string, unknown> | null } }>()
  const isAuthenticated = Boolean(props.auth?.user)
  const pages = pagination.links.pages
  const showPagination = pagination.meta.lastPage > 1

  return (
    <Layout
      mainClassName="max-w-4xl mx-auto px-6 pt-10 pb-16 sm:pt-12 sm:pb-24"
    >
      <div className="space-y-16">
        {/* Header Section */}
        <section className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">
              Posts
            </h1>
            <p className="mt-3 text-base text-stone-400">
              Thoughts, stories, and ideas from the Guren team.
            </p>
          </div>

          {isAuthenticated && (
            <Link
              href={route('posts.create')}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-900 focus:ring-offset-2"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New post
            </Link>
          )}
        </section>

        {/* Posts List */}
        <section>
          {posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <p className="text-lg font-medium text-stone-900">No posts yet</p>
              <p className="mt-1 text-sm text-stone-400">Get started by creating your first post.</p>
              <div className="mt-6">
                <Link
                  href={route('posts.create')}
                  className="inline-flex items-center gap-2 rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  Create post
                </Link>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {posts.map((post) => (
                <article key={post.id} className="group">
                  <Link
                    href={route('posts.show', { id: post.id })}
                    className="block py-8 sm:py-10 sm:flex sm:items-start sm:gap-10"
                  >
                    <time className="mb-2 block shrink-0 text-xs font-normal uppercase tracking-widest text-stone-400 sm:mb-0 sm:w-28 sm:pt-1.5">
                      {new Date().toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric'
                      })}
                    </time>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-xl font-medium text-stone-900 transition-colors group-hover:text-guren-600">
                        {post.title}
                      </h2>
                      <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-stone-500">
                        {post.excerpt}
                      </p>
                      <p className="mt-3 text-xs text-stone-400">
                        {post.author?.name ?? 'Unknown'}
                      </p>
                    </div>
                    {post.cover && (
                      <img
                        src={post.cover.variants.thumb?.url ?? post.cover.url}
                        alt=""
                        data-testid="post-cover-thumb"
                        loading="lazy"
                        className="mt-4 h-20 w-32 shrink-0 rounded-md object-cover ring-1 ring-stone-100 sm:mt-1"
                        // ThumbHash LQIP behind the thumb while it loads.
                        style={
                          post.cover.placeholder
                            ? { backgroundImage: `url(${post.cover.placeholder})`, backgroundSize: 'cover' }
                            : undefined
                        }
                      />
                    )}
                  </Link>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Pagination */}
        {showPagination && (
          <div className="flex items-center justify-center border-t border-stone-100 pt-10">
            <nav className="flex items-center gap-1" aria-label="Pagination">
              {pagination.links.prev ? (
                <Link
                  href={pagination.links.prev}
                  preserveScroll
                  preserveState
                  className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm text-stone-500 transition-colors hover:text-stone-900"
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm text-stone-300"
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </span>
              )}

              <div className="flex items-center gap-1 px-2">
                {pages.map((pageLink) => (
                  <Link
                    key={pageLink.page}
                    href={pageLink.url ?? '#'}
                    preserveScroll
                    preserveState
                    className={`inline-flex h-9 w-9 items-center justify-center rounded-md text-sm font-medium transition-colors ${pageLink.active
                      ? 'bg-stone-900 text-white'
                      : 'text-stone-400 hover:text-stone-900'
                      }`}
                    aria-current={pageLink.active ? 'page' : undefined}
                    aria-disabled={pageLink.url ? undefined : true}
                    tabIndex={pageLink.url ? undefined : -1}
                  >
                    {pageLink.page}
                  </Link>
                ))}
              </div>

              {pagination.links.next ? (
                <Link
                  href={pagination.links.next}
                  preserveScroll
                  preserveState
                  className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm text-stone-500 transition-colors hover:text-stone-900"
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm text-stone-300"
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </span>
              )}
            </nav>
          </div>
        )}
      </div>
    </Layout>
  )
}
