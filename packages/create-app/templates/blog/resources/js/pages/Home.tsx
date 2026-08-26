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
          <h1 className="flex items-center gap-4 text-4xl font-bold tracking-tight text-g-heading">
            <span aria-hidden className="h-9 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            __APP_TITLE__
          </h1>
          <p className="text-g-text-2">
            A blog built with Guren — controllers on the server, React pages over Inertia, one
            codebase. Edit <code className="rounded bg-g-ink px-1.5 py-0.5 font-mono text-sm text-g-on-ink">resources/js/pages/Home.tsx</code>{' '}
            to make it yours.
          </p>
        </header>

        <div className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-bold text-g-heading">Latest posts</h2>
            <Link href="/posts" className="text-sm text-g-accent-text transition hover:underline">
              All posts →
            </Link>
          </div>

          {latest.length === 0 ? (
            <p className="rounded-g-card border border-g-line bg-g-panel px-4 py-6 text-sm text-g-text-2">
              No posts yet. Run <code className="font-mono text-g-accent-text">bun run db:seed</code> for sample content,
              or sign in and write the first one.
            </p>
          ) : (
            <ul className="space-y-4">
              {latest.map((post) => (
                <li key={post.id} className="rounded-g-card border border-g-line bg-g-panel p-5 shadow-g-card">
                  <Link href={`/posts/${post.id}`} className="text-lg font-bold text-g-heading transition hover:text-g-accent-text">
                    {post.title}
                  </Link>
                  <p className="mt-2 text-sm text-g-text-2">{post.excerpt}</p>
                  {post.author ? (
                    <p className="mt-3 font-mono text-xs uppercase tracking-wide text-g-muted">by {post.author.name}</p>
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
