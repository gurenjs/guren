import { Link, router, usePage } from '@inertiajs/react'
import type { PostsIndexPageProps } from '@/Http/Controllers/PostController'
import Layout from '../../components/Layout.js'
import { FolderPlus, MoveRight, Newspaper, Plus } from 'lucide-react'

export default function Index({ posts, pagination }: PostsIndexPageProps) {
  const { url } = usePage()
  const currentPath = pagination.basePath || (url.split('?')[0] || '/')
  const pages = Array.from({ length: pagination.totalPages }, (_, index) => index + 1)
  const canGoPrevious = pagination.currentPage > 1
  const canGoNext = pagination.currentPage < pagination.totalPages

  const visitPage = (pageNumber: number) => {
    const safePage = Math.max(1, Math.min(pageNumber, pagination.totalPages))

    if (safePage === pagination.currentPage) {
      return
    }

    const query = safePage > 1 ? `?page=${safePage}` : ''
    router.visit(`${currentPath}${query}`, {
      preserveScroll: true,
      preserveState: true,
    })
  }

  const goToPrevious = () => {
    if (canGoPrevious) {
      visitPage(pagination.currentPage - 1)
    }
  }

  const goToNext = () => {
    if (canGoNext) {
      visitPage(pagination.currentPage + 1)
    }
  }

  const showPagination = pagination.totalPages > 1

  return (
    <Layout
      wrapperClassName="relative bg-linear-to-br from-[#FFF0F0] via-[#FFE3E3] to-[#F5C5C5] text-[#3C0A0A]"
      mainClassName="relative mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-12"
    >
      <div className="relative z-10 space-y-10">
        {/* Header Section */}
        <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 md:flex-row md:items-center md:justify-between">
          <div className="flex-1 space-y-4 text-center md:text-left">
            <h1 className="flex items-center justify-center gap-3 text-4xl font-bold text-[#8F1111] md:justify-start md:text-5xl">
              <Newspaper className="h-10 w-10 text-[#B71C1C]" aria-hidden />
              Latest Posts
            </h1>
          </div>

          <div className="flex w-full flex-col items-center gap-4 md:w-auto md:items-end">
            <Link
              href="/posts/new"
              className="inline-flex items-center gap-2 rounded-full bg-linear-to-br from-[#B71C1C] to-[#8F1111] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-[#B71C1C]/30 transition-all duration-200 hover:from-[#C92A2A] hover:to-[#7A0F0F] hover:shadow-xl"
            >
              <Plus className="h-4 w-4" aria-hidden />
              Create new post
            </Link>
          </div>
        </section>

        {/* Posts Grid */}
        <section>
          {posts.length === 0 ? (
            <div className="py-16 text-center">
              <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-[#FDE1E1]">
                <FolderPlus className="h-12 w-12 text-[#E35151]" aria-hidden />
              </div>
              <h3 className="mb-2 text-xl font-semibold text-[#8F1111]">No posts yet</h3>
              <p className="text-[#6B1B1B]">Check back later for new content!</p>
              <div className="mt-8 flex justify-center">
                <Link
                  href="/posts/new"
                  className="inline-flex items-center gap-2 rounded-xl bg-linear-to-br from-[#B71C1C] to-[#8F1111] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-[#B71C1C]/30 transition-all duration-200 hover:from-[#C92A2A] hover:to-[#7A0F0F] hover:shadow-xl"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  Create your first post
                </Link>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
              {posts.map((post) => (
                <article
                  key={post.id}
                  className="group relative overflow-hidden rounded-2xl border border-[#F4B0B0] bg-white shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-[#DC7C7C] hover:shadow-xl"
                >
                  {/* Card Header with Gradient */}
                  <div className="h-2 bg-linear-to-r from-[#FFC1C1] via-[#E35151] to-[#B71C1C]" />

                  {/* Card Content */}
                  <div className="p-6">
                    {/* Post Meta */}
                    <div className="mb-4 flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <div className="h-2 w-2 animate-pulse rounded-full bg-[#FF9D9D]" />
                        <span className="text-sm font-medium text-[#7A1A1A]">
                          Post #{post.id}
                        </span>
                      </div>
                      <div className="text-sm text-[#A65555]">
                        {new Date().toLocaleDateString('ja-JP', {
                          month: 'short',
                          day: 'numeric'
                        })}
                      </div>
                    </div>

                    {/* Post Title */}
                    <h2 className="mb-3 line-clamp-2 text-xl font-bold text-[#8F1111] transition-colors duration-200 group-hover:text-[#B71C1C]">
                      {post.title}
                    </h2>

                    {/* Post Excerpt */}
                    <p className="mb-6 line-clamp-3 leading-relaxed text-[#6B1B1B]">
                      {post.excerpt}
                    </p>

                    {/* Card Footer */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-linear-to-br from-[#FFC1C1] to-[#B71C1C] text-white">
                          <span className="text-sm font-semibold">
                            {(post.author?.name ?? post.title).charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[#8F1111]">{post.author?.name ?? 'Unknown author'}</p>
                          <p className="text-xs text-[#A65555]">{post.author ? `@${post.author.name.toLowerCase().replace(/\s+/g, '')}` : 'Guest post'}</p>
                        </div>
                      </div>

                      <Link
                        href={`/posts/${post.id}`}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#FFE3E3] px-3 py-1.5 text-sm font-medium text-[#B71C1C] transition-colors duration-200 hover:bg-[#F5C5C5] group-hover:scale-105 group-hover:transform"
                      >
                        Read more
                        <MoveRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" aria-hidden />
                      </Link>
                    </div>
                  </div>

                  {/* Hover Effect Overlay */}
                  <div className="pointer-events-none absolute inset-0 bg-linear-to-br from-[#B71C1C]/5 to-[#7A0F0F]/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Pagination */}
        {showPagination && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goToPrevious}
                disabled={!canGoPrevious}
                className="inline-flex items-center rounded-lg bg-[#FFE3E3] px-3 py-2 text-sm font-medium text-[#8F1111] transition-colors duration-200 enabled:hover:bg-[#F5C5C5] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <div className="hidden text-sm text-[#6B1B1B] sm:block">Page {pagination.currentPage} of {pagination.totalPages}</div>
              <button
                type="button"
                onClick={goToNext}
                disabled={!canGoNext}
                className="inline-flex items-center rounded-lg bg-[#FFE3E3] px-3 py-2 text-sm font-medium text-[#8F1111] transition-colors duration-200 enabled:hover:bg-[#F5C5C5] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              {pages.map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  onClick={() => visitPage(pageNumber)}
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold transition-all duration-200 ${pageNumber === pagination.currentPage
                      ? 'bg-linear-to-br from-[#B71C1C] to-[#8F1111] text-white shadow-lg shadow-[#B71C1C]/30'
                      : 'bg-white text-[#B71C1C] shadow border border-[#F4B0B0] hover:bg-[#FFE3E3]'
                    }`}
                  aria-current={pageNumber === pagination.currentPage ? 'page' : undefined}
                >
                  {pageNumber}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Background Decorations */}
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-[#F5C5C5] opacity-30 blur-xl mix-blend-multiply animate-blob" />
        <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-[#E35151] opacity-20 blur-xl mix-blend-multiply animate-blob animation-delay-2000" />
        <div className="absolute top-40 left-40 h-80 w-80 rounded-full bg-[#FF9D9D] opacity-20 blur-xl mix-blend-multiply animate-blob animation-delay-4000" />
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
          @keyframes blob {
            0% {
              transform: translate(0px, 0px) scale(1);
            }
            33% {
              transform: translate(30px, -50px) scale(1.1);
            }
            66% {
              transform: translate(-20px, 20px) scale(0.9);
            }
            100% {
              transform: translate(0px, 0px) scale(1);
            }
          }
          .animate-blob {
            animation: blob 7s infinite;
          }
          .animation-delay-2000 {
            animation-delay: 2s;
          }
          .animation-delay-4000 {
            animation-delay: 4s;
          }
          .line-clamp-2 {
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .line-clamp-3 {
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
        `
        }}
      />
    </Layout>
  )
}
