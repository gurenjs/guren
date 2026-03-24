import { useForm } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import PostForm, { type PostFormValues } from '../../components/PostForm.js'
import type { RouteErrors } from '@guren/inertia-client/typed-forms'
import { route } from '../../../../.guren/routes.gen'

interface Props {
  post: PostFormValues | null
  postId: number
  errors?: RouteErrors<PostFormValues> & { message?: string }
}

export default function Edit({ post, postId, errors = {} }: Props) {
  const form = useForm<PostFormValues>({
    title: post?.title ?? '',
    excerpt: post?.excerpt ?? '',
    body: post?.body ?? ''
  })

  const handleSubmit = (data: PostFormValues) => {
    form.setData(data)
    form.put(route('posts.update', { id: postId }))
  }

  const handleCancel = () => {
    if (window.confirm('編集をキャンセルしますか？変更内容は失われます。')) {
      form.reset()
      window.history.back()
    }
  }

  if (!post) {
    return (
      <Layout>
        <div className="mx-auto mt-12 max-w-xl rounded-lg bg-white p-8 text-center shadow-sm">
          <h2 className="text-2xl font-semibold text-stone-900 mb-3">Post Not Found</h2>
          <p className="text-stone-400">{errors?.message ?? 'The requested post could not be found.'}</p>
          <button
            onClick={() => window.history.back()}
            className="mt-6 inline-flex items-center justify-center rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-800"
          >
            Go Back
          </button>
        </div>
      </Layout>
    )
  }

  return (
    <PostForm
      mode="edit"
      form={form}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  )
}
