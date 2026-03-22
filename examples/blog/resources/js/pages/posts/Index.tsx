import { Link } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import { ArrowRight, Calendar, ChevronLeft, ChevronRight, Plus, User } from 'lucide-react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '../../../../app/Http/Resources/PostResource.js'

interface Props extends PaginatedPageProps<PostResourceData> {}

export default function Index({ data: posts, pagination }: Props) {
  const pages = pagination.links.pages
  const canGoPrevious = Boolean(pagination.links.prev)
  const canGoNext = Boolean(pagination.links.next)
  const showPagination = pagination.meta.lastPage > 1

  return (
    <Layout
      wrapperClassName="bg-zinc-50"
      mainClassName="max-w-5xl mx-auto px-6 py-12"
    >
      <div className="space-y-12">
        {/* Header Section */}
        <section className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-zinc-900 sm:text-4xl">
              Latest Posts
            </h1>
            <p className="text-lg text-zinc-500">
              Thoughts, stories, and ideas from the Guren team.
            </p>
          </div>

          <Link
            href="/posts/new"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-zinc-200 transition hover:bg-zinc-800 hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2"
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create new post
          </Link>
        </section>

        {/* Posts Grid */}
        <section>
          {posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 py-24 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100">
                <Plus className="h-8 w-8 text-zinc-400" aria-hidden />
              </div>
              <h3 className="text-lg font-semibold text-zinc-900">No posts yet</h3>
              <p className="mt-1 text-zinc-500">Get started by creating your first post.</p>
              <div className="mt-6">
                <Link
                  href="/posts/new"
                  className="inline-flex items-center gap-2 rounded-full bg-guren-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-guren-500"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  Create post
                </Link>
              </div>
            </div>
          ) : (
            <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
              {posts.map((post) => (
                <article
                  key={post.id}
                  className="group relative flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-zinc-200 transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:ring-zinc-300"
                >
                  <div className="flex flex-1 flex-col p-6">
                    <div className="mb-4 flex items-center gap-3 text-xs font-medium text-zinc-500">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3.5 w-3.5" />
                        {new Date().toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </span>
                      <span className="h-1 w-1 rounded-full bg-zinc-300" />
                      <span className="text-guren-600">Article</span>
                    </div>

                    <h2 className="mb-3 text-xl font-bold tracking-tight text-zinc-900 transition group-hover:text-guren-600">
                      <Link href={`/posts/${post.id}`} className="focus:outline-none">
                        <span className="absolute inset-0" aria-hidden="true" />
                        {post.title}
                      </Link>
                    </h2>

                    <p className="mb-6 line-clamp-3 flex-1 text-sm leading-relaxed text-zinc-600">
                      {post.excerpt}
                    </p>

                    <div className="mt-auto flex items-center justify-between border-t border-zinc-100 pt-4">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-guren-50 text-guren-600 ring-1 ring-guren-100">
                          <User className="h-4 w-4" />
                        </div>
                        <div className="text-xs">
                          <p className="font-medium text-zinc-900">{post.author?.name ?? 'Unknown'}</p>
                          <p className="text-zinc-500">Author</p>
                        </div>
                      </div>

                      <span className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition group-hover:bg-guren-50 group-hover:text-guren-600">
                        <ArrowRight className="h-4 w-4" />
                      </span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Pagination */}
        {showPagination && (
          <div className="flex items-center justify-center border-t border-zinc-200 pt-8">
            <nav className="flex items-center gap-1" aria-label="Pagination">
              {pagination.links.prev ? (
                <Link
                  href={pagination.links.prev}
                  preserveScroll
                  preserveState
                  className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Previous
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-zinc-500 opacity-50"
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
                    className={`inline-flex h-9 w-9 items-center justify-center rounded-md text-sm font-medium transition ${pageLink.active
                      ? 'bg-zinc-900 text-white shadow-sm'
                      : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900'
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
                  className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  className="inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-50"
                >
                  <>
                    Next
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </>
                </span>
              )}
            </nav>
          </div>
        )}
      </div>
    </Layout>
  )
}
