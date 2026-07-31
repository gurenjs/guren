import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { route } from '@/.guren/routes.gen'
import Layout from '../../components/Layout.js'

type PostFormData = ApiRoutes['posts.store']['body']

const fieldClass =
  'mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none ring-emerald-400 transition focus:border-emerald-400 focus:ring'

export default function NewPost() {
  const form = useForm<PostFormData>({ title: '', excerpt: '', body: '' })

  return (
    <Layout>
      <Head title="New post" />
      <section className="space-y-6">
        <h1 className="text-3xl font-semibold text-emerald-300">New post</h1>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post(route('posts.store'))
          }}
        >
          <div>
            <label className="block text-sm font-medium text-slate-200">Title</label>
            <input
              type="text"
              value={form.data.title}
              onChange={(event) => form.setData('title', event.target.value)}
              className={fieldClass}
            />
            {form.errors.title ? <p className="mt-1 text-sm text-rose-300">{form.errors.title}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-200">Excerpt</label>
            <input
              type="text"
              value={form.data.excerpt}
              onChange={(event) => form.setData('excerpt', event.target.value)}
              className={fieldClass}
            />
            {form.errors.excerpt ? <p className="mt-1 text-sm text-rose-300">{form.errors.excerpt}</p> : null}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-200">Body</label>
            <textarea
              rows={10}
              value={form.data.body}
              onChange={(event) => form.setData('body', event.target.value)}
              className={fieldClass}
            />
            {form.errors.body ? <p className="mt-1 text-sm text-rose-300">{form.errors.body}</p> : null}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Publish
          </button>
        </form>
      </section>
    </Layout>
  )
}
