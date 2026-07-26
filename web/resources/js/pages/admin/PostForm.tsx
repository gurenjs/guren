import { Head, Link, useForm } from '@inertiajs/react'
import type { FormEvent } from 'react'
import { pageTitle } from '../../../../config/site.js'

type EditablePost = {
  id: number
  slug: string
  title: string
  description: string | null
  bodyMarkdown: string
}

interface Props {
  post: EditablePost | null
}

export default function AdminPostForm({ post }: Props) {
  const form = useForm({
    title: post?.title ?? '',
    description: post?.description ?? '',
    bodyMarkdown: post?.bodyMarkdown ?? '',
  })

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    form.post(post ? `/admin/posts/${post.id}` : '/admin/posts')
  }

  const fieldClass =
    'w-full rounded-lg border border-docs-border bg-docs-page px-3 py-2 text-docs-text'

  return (
    <>
      <Head title={pageTitle(post ? 'Edit post' : 'New post')} />

      <main className="mx-auto w-full max-w-[760px] px-6 py-16">
        <header className="mb-10 flex items-center justify-between gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight text-docs-heading">
            {post ? `Edit: ${post.title}` : 'New post'}
          </h1>
          <Link href="/admin" className="font-semibold text-docs-accent no-underline">
            ← Back to posts
          </Link>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-docs-heading">Title</span>
            <input
              type="text"
              value={form.data.title}
              onChange={(event) => form.setData('title', event.target.value)}
              className={fieldClass}
            />
            {form.errors.title && <span className="text-sm text-red-600">{form.errors.title}</span>}
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-docs-heading">Description</span>
            <input
              type="text"
              value={form.data.description}
              onChange={(event) => form.setData('description', event.target.value)}
              className={fieldClass}
            />
            {form.errors.description && (
              <span className="text-sm text-red-600">{form.errors.description}</span>
            )}
          </label>

          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-docs-heading">Body (Markdown)</span>
            <textarea
              value={form.data.bodyMarkdown}
              onChange={(event) => form.setData('bodyMarkdown', event.target.value)}
              rows={20}
              className={`${fieldClass} font-mono text-sm`}
            />
            {form.errors.bodyMarkdown && (
              <span className="text-sm text-red-600">{form.errors.bodyMarkdown}</span>
            )}
          </label>

          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={form.processing}
              className="rounded-full bg-docs-accent px-6 py-2.5 font-semibold text-white disabled:opacity-60"
            >
              {post ? 'Save changes' : 'Create post'}
            </button>
            {post && (
              <span className="text-sm text-docs-text-muted">
                Slug: <code>{post.slug}</code> (stable across edits)
              </span>
            )}
          </div>
        </form>
      </main>
    </>
  )
}
