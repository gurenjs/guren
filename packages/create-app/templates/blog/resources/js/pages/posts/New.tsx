import { Head, useForm } from '@inertiajs/react'
import { useId } from 'react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { route } from '@/.guren/routes.gen'
import { Input } from '@/resources/js/components/ui/Input'
import { Label } from '@/resources/js/components/ui/Label'
import { Textarea } from '@/resources/js/components/ui/Textarea'
import Layout from '../../components/Layout.js'

type PostFormData = ApiRoutes['posts.store']['body']

export default function NewPost() {
  const form = useForm<PostFormData>({ title: '', excerpt: '', body: '' })

  const titleId = useId()
  const excerptId = useId()
  const bodyId = useId()

  return (
    <Layout>
      <Head title="New post" />
      <section className="space-y-6">
        <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
          <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
          New post
        </h1>

        <form
          method="post"
          action={route('posts.store')}
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            form.post(route('posts.store'))
          }}
        >
          <div>
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              type="text"
              value={form.data.title}
              onChange={(event) => form.setData('title', event.target.value)}
              className="mt-1"
            />
            {form.errors.title ? <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p> : null}
          </div>

          <div>
            <Label htmlFor={excerptId}>Excerpt</Label>
            <Input
              id={excerptId}
              type="text"
              value={form.data.excerpt}
              onChange={(event) => form.setData('excerpt', event.target.value)}
              className="mt-1"
            />
            {form.errors.excerpt ? <p className="mt-1 text-sm text-g-danger">{form.errors.excerpt}</p> : null}
          </div>

          <div>
            <Label htmlFor={bodyId}>Body</Label>
            <Textarea
              id={bodyId}
              rows={10}
              value={form.data.body}
              onChange={(event) => form.setData('body', event.target.value)}
              className="mt-1"
            />
            {form.errors.body ? <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p> : null}
          </div>

          <button
            type="submit"
            disabled={form.processing}
            className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down disabled:cursor-not-allowed disabled:opacity-45"
          >
            Publish
          </button>
        </form>
      </section>
    </Layout>
  )
}
