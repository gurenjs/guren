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
          <h1 className="text-3xl font-semibold text-emerald-300">{post.title}</h1>
          <p className="text-sm text-slate-500">
            {post.author ? `by ${post.author.name} · ` : ''}
            {new Date(post.createdAt).toLocaleDateString()}
          </p>
          <p className="text-slate-400">{post.excerpt}</p>
        </header>

        <div className="whitespace-pre-wrap text-slate-200">{post.body}</div>

        <footer className="flex gap-4 border-t border-slate-800 pt-6 text-sm">
          <Link href={route('posts.index')} className="text-slate-300 transition hover:text-emerald-200">
            ← All posts
          </Link>
          {canManage ? (
            <>
              <Link href={route('posts.edit', { id: post.id })} className="text-emerald-300 transition hover:text-emerald-200">
                Edit
              </Link>
              <Link
                href={route('posts.destroy', { id: post.id })}
                method="delete"
                as="button"
                onBefore={() => window.confirm('Delete this post?')}
                className="text-rose-400 transition hover:text-rose-300"
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
