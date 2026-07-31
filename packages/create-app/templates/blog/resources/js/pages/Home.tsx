import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import Layout from '../components/Layout.js'

interface Props {
  latest: PostResourceData[]
}

export default function Home({ latest }: Props) {
  return (
    <Layout>
      <Head title="__APP_TITLE__" />
      <section className="space-y-10">
        <header className="space-y-3">
          <h1 className="text-4xl font-semibold tracking-tight text-emerald-300">__APP_TITLE__</h1>
          <p className="text-slate-400">
            A blog built with Guren — controllers on the server, React pages over Inertia, one
            codebase. Edit <code className="rounded bg-slate-900 px-1.5 py-0.5 text-sm text-emerald-200">resources/js/pages/Home.tsx</code>{' '}
            to make it yours.
          </p>
        </header>

        <div className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-medium text-slate-100">Latest posts</h2>
            <Link href="/posts" className="text-sm text-emerald-300 transition hover:text-emerald-200">
              All posts →
            </Link>
          </div>

          {latest.length === 0 ? (
            <p className="rounded border border-slate-800 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">
              No posts yet. Run <code className="text-emerald-200">bun run db:seed</code> for sample content,
              or sign in and write the first one.
            </p>
          ) : (
            <ul className="space-y-4">
              {latest.map((post) => (
                <li key={post.id} className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
                  <Link href={`/posts/${post.id}`} className="text-lg font-medium text-slate-100 transition hover:text-emerald-200">
                    {post.title}
                  </Link>
                  <p className="mt-2 text-sm text-slate-400">{post.excerpt}</p>
                  {post.author ? (
                    <p className="mt-3 text-xs uppercase tracking-wide text-slate-500">by {post.author.name}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </Layout>
  )
}
