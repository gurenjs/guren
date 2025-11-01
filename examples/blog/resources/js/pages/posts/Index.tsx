import { Link } from '@inertiajs/react'
import type { PostsIndexPageProps } from '@/Http/Controllers/PostController'
import Layout from '../../components/Layout'

export default function Index({ posts }: PostsIndexPageProps) {
  return (
    <Layout
      wrapperClassName="relative bg-linear-to-br from-[#FFF0F0] via-[#FFE3E3] to-[#F5C5C5] text-[#3C0A0A]"
      mainClassName="relative mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-12"
    >
      <div className="relative z-10 space-y-10">
        {/* Header Section */}
        <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 md:flex-row md:items-center md:justify-between">
          <div className="flex-1 space-y-4 text-center md:text-left">
            <h1 className="text-4xl font-bold text-[#8F1111] md:text-5xl">
              Latest Posts
            </h1>
          </div>

          <div className="flex w-full flex-col items-center gap-4 md:w-auto md:items-end">
            <Link
              href="/posts/new"
              className="inline-flex items-center rounded-full bg-linear-to-br from-[#B71C1C] to-[#8F1111] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-[#B71C1C]/30 transition-all duration-200 hover:from-[#C92A2A] hover:to-[#7A0F0F] hover:shadow-xl"
            >
              <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create new post
            </Link>
          </div>
        </section>

        {/* Posts Grid */}
        <section>
          {posts.length === 0 ? (
            <div className="py-16 text-center">
              <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-[#FDE1E1]">
                <svg className="h-12 w-12 text-[#E35151]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <h3 className="mb-2 text-xl font-semibold text-[#8F1111]">No posts yet</h3>
              <p className="text-[#6B1B1B]">Check back later for new content!</p>
              <div className="mt-8 flex justify-center">
                <Link
                  href="/posts/new"
                  className="inline-flex items-center rounded-xl bg-linear-to-br from-[#B71C1C] to-[#8F1111] px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-[#B71C1C]/30 transition-all duration-200 hover:from-[#C92A2A] hover:to-[#7A0F0F] hover:shadow-xl"
                >
                  <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
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
                            {post.title.charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[#8F1111]">Author</p>
                          <p className="text-xs text-[#A65555]">5 min read</p>
                        </div>
                      </div>

                      <Link
                        href={`/posts/${post.id}`}
                        className="inline-flex items-center rounded-lg bg-[#FFE3E3] px-3 py-1.5 text-sm font-medium text-[#B71C1C] transition-colors duration-200 hover:bg-[#F5C5C5] group-hover:scale-105 group-hover:transform"
                      >
                        Read more
                        <svg className="ml-1 h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
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

        {/* Load More Section */}
        {posts.length > 0 && (
          <div className="text-center">
            <button className="inline-flex items-center rounded-xl bg-linear-to-br from-[#B71C1C] to-[#8F1111] px-6 py-3 text-base font-medium text-white shadow-lg shadow-[#B71C1C]/30 transition-all duration-200 hover:from-[#C92A2A] hover:to-[#7A0F0F] hover:scale-105 hover:shadow-xl">
              Load More Posts
              <svg className="ml-2 h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
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
