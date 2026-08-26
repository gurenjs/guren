import { Head, Link, usePage } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'
import Layout from '../../components/Layout.js'

interface Props {
  post: PostResourceData
}

export default function PostShow({ post }: Props) {
  const { props } = usePage<{ auth?: { user?: { id?: number } } }>()
  // Mirrors PostPolicy — the server rejects it either way, this only keeps
  // controls the viewer cannot use off the page.
  const canManage = props.auth?.user?.id === post.authorId

  return (
    <Layout>
      <Head title={post.title} />
      <article className="space-y-6">
        <header className="space-y-2">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            {post.title}
          </h1>
          <p className="text-sm text-g-muted">
            {post.author ? `by ${post.author.name} · ` : ''}
            {new Date(post.createdAt).toLocaleDateString()}
          </p>
          <p className="text-g-text-2">{post.excerpt}</p>
        </header>

        <div className="whitespace-pre-wrap text-g-text">{post.body}</div>

        <footer className="flex items-center gap-4 border-t border-g-line pt-6 text-sm">
          <Link href={route('posts.index')} className="text-g-text-2 transition hover:text-g-heading">
            ← All posts
          </Link>
          {canManage ? (
            <>
              <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
                Edit
              </Link>
              <Link
                href={route('posts.destroy', { id: post.id })}
                method="delete"
                as="button"
                onBefore={() => window.confirm('Delete this post?')}
                className="rounded-g-ctl border border-g-danger-chip px-3 py-1 font-bold text-g-danger transition hover:bg-g-danger-tint"
              >
                Delete
              </Link>
            </>
          ) : null}
        </footer>
      </article>
    </Layout>
  )
}
