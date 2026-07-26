import { Head, Link, router } from '@inertiajs/react'
import { pageTitle } from '../../../../config/site.js'

type AdminPostSummary = {
  id: number
  slug: string
  title: string
  publishedAt: string | null
  updatedAt: string
}

interface Props {
  posts: AdminPostSummary[]
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export default function AdminPosts({ posts }: Props) {
  const togglePublish = (post: AdminPostSummary) => {
    router.post(`/admin/posts/${post.id}/publish`, { published: !post.publishedAt })
  }

  const destroy = (post: AdminPostSummary) => {
    if (window.confirm(`Delete "${post.title}"? This cannot be undone.`)) {
      router.post(`/admin/posts/${post.id}/delete`)
    }
  }

  return (
    <>
      <Head title={pageTitle('Admin')} />

      <main className="mx-auto w-full max-w-[900px] px-6 py-16">
        <header className="mb-10 flex items-center justify-between gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-docs-heading">Posts</h1>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/posts/new"
              className="rounded-full bg-docs-accent px-5 py-2 font-semibold text-white no-underline"
            >
              New post
            </Link>
            <button
              type="button"
              onClick={() => router.post('/logout')}
              className="rounded-full border border-docs-border px-5 py-2 font-semibold text-docs-text-secondary"
            >
              Log out
            </button>
          </div>
        </header>

        {posts.length === 0 ? (
          <p className="text-docs-text-muted">No posts yet. Write the first one.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-docs-border text-xs font-bold uppercase tracking-widest text-docs-text-muted">
                  <th className="px-3 py-2">Title</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Updated</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => (
                  <tr key={post.id} className="border-b border-docs-border">
                    <td className="px-3 py-3">
                      <Link
                        href={`/blog/${post.slug}`}
                        className="font-semibold text-docs-heading no-underline hover:underline"
                      >
                        {post.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      {post.publishedAt ? (
                        <span className="text-sm font-semibold text-docs-accent">
                          Published {formatDate(post.publishedAt)}
                        </span>
                      ) : (
                        <span className="text-sm text-docs-text-muted">Draft</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-sm text-docs-text-muted">{formatDate(post.updatedAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3 text-sm">
                        <Link href={`/admin/posts/${post.id}/edit`} className="font-semibold text-docs-accent no-underline">
                          Edit
                        </Link>
                        <button type="button" onClick={() => togglePublish(post)} className="font-semibold text-docs-text-secondary">
                          {post.publishedAt ? 'Unpublish' : 'Publish'}
                        </button>
                        <button type="button" onClick={() => destroy(post)} className="font-semibold text-red-600">
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  )
}
