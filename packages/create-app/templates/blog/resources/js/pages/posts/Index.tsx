import { Head, Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'
import Layout from '../../components/Layout.js'

interface Props extends PaginatedPageProps<PostResourceData> {}

export default function PostsIndex({ data, pagination }: Props) {
  return (
    <Layout>
      <Head title="Posts" />
      <section className="space-y-6">
        <h1 className="text-3xl font-semibold text-emerald-300">Posts</h1>

        <div className="space-y-4">
          {data.map((post) => (
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

        {pagination?.links?.pages && (
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
