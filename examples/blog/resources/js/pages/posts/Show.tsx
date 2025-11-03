import { Link } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import type { PostShowPageProps } from '@/Http/Controllers/PostController'

export default function Show({ post }: PostShowPageProps) {
  const paragraphs = post.body?.split(/\n+/).filter(Boolean) ?? []

  return (
    <Layout
      wrapperClassName="relative bg-linear-to-br from-[#FFF0F0] via-[#FFE3E3] to-[#F5C5C5] text-[#3C0A0A]"
      mainClassName="relative mx-auto w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-12"
    >
      <div className="relative z-10 space-y-10">
        <section className="rounded-3xl border border-[#F4B0B0] bg-white/90 p-8 shadow-lg shadow-[#B71C1C]/10 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Link
              href="/posts"
              className="inline-flex items-center text-sm font-medium text-[#B71C1C] transition-colors duration-200 hover:text-[#7A0F0F]"
            >
              <svg className="mr-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to posts
            </Link>
            <Link
              href={`/posts/${post.id}/edit`}
              className="inline-flex items-center rounded-xl bg-linear-to-r from-[#B71C1C] to-[#8F1111] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[#B71C1C]/30 transition-all duration-200 hover:from-[#C92A2A] hover:to-[#7A0F0F] hover:shadow-xl"
            >
              <svg className="mr-2 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5h2m-1 1v4m5 4h2a2 2 0 012 2v3a2 2 0 01-2 2h-5m-4 0H7a2 2 0 01-2-2v-3a2 2 0 012-2h2m4 5h-4m0 0v-5a2 2 0 012-2h0a2 2 0 012 2v5z" />
              </svg>
              Edit post
            </Link>
          </div>

          <header className="mt-6 space-y-4">
            <span className="inline-flex items-center rounded-full bg-[#FFE3E3] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[#B71C1C]">
              Featured Insight
            </span>
            <h1 className="text-4xl md:text-5xl font-bold text-[#8F1111] leading-tight">
              {post.title}
            </h1>
            <p className="max-w-3xl text-lg text-[#6B1B1B]">
              {post.excerpt}
            </p>
          </header>
        </section>

        <article className="relative rounded-3xl border border-[#F4B0B0] bg-white p-10 shadow-xl">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-linear-to-br from-[#FFC1C1] to-[#B71C1C] text-xl font-semibold text-white">
              {(post.author?.name ?? post.title).charAt(0).toUpperCase()}
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-[#8F1111]">{post.author?.name ?? 'Unknown author'}</p>
              <p className="text-xs text-[#A65555]">
                Published {new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </div>
          </div>

          <div className="my-6 h-px w-full bg-linear-to-r from-[#FFE3E3] via-[#F5C5C5] to-[#FFE3E3]" />

          {paragraphs.length > 0 ? (
            <div className="space-y-6 text-lg leading-relaxed text-[#5C1616]">
              {paragraphs.map((paragraph, index) => (
                <p
                  key={index}
                  className="first-letter:float-left first-letter:mr-2 first-letter:text-4xl first-letter:font-bold first-letter:text-[#B71C1C]"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-[#A65555]">No additional content is available for this post yet.</p>
          )}
        </article>
      </div>

      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-16 -right-32 h-64 w-64 rounded-full bg-[#F5C5C5] opacity-20 blur-3xl mix-blend-multiply" />
        <div className="absolute -bottom-20 -left-32 h-64 w-64 rounded-full bg-[#E35151] opacity-15 blur-3xl mix-blend-multiply" />
      </div>
    </Layout>
  )
}
