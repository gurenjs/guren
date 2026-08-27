import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { route } from '@/.guren/routes.gen'
import Layout from '../../components/Layout.js'

type PostFormData = ApiRoutes['posts.store']['body']

interface Props {
  post: PostFormData & { id: number }
}

const fieldClass =
  'mt-1 w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function EditPost({ post }: Props) {
  const form = useForm<PostFormData>({
    title: post.title,
    excerpt: post.excerpt,
    body: post.body,
  })

  return (
    <Layout>
      <Head title={`Edit ${post.title}`} />
      <section className="space-y-6">
        <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
          <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          Edit post
        </h1>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.put(route('posts.update', { id: post.id }))
          }}
        >
          <div>
            <label className="block text-sm font-bold text-g-heading">Title</label>
            <input
              type="text"
              value={form.data.title}
              onChange={(event) => form.setData('title', event.target.value)}
              className={fieldClass}
            />
            {form.errors.title ? <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-bold text-g-heading">Excerpt</label>
            <input
              type="text"
              value={form.data.excerpt}
              onChange={(event) => form.setData('excerpt', event.target.value)}
              className={fieldClass}
            />
            {form.errors.excerpt ? <p className="mt-1 text-sm text-g-danger">{form.errors.excerpt}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-bold text-g-heading">Body</label>
            <textarea
              rows={10}
              value={form.data.body}
              onChange={(event) => form.setData('body', event.target.value)}
              className={fieldClass}
            />
            {form.errors.body ? <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p> : null}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down disabled:cursor-not-allowed disabled:opacity-45"
          >
            Save changes
          </button>
        </form>
      </section>
    </Layout>
  )
}
