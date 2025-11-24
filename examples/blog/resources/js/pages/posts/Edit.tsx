import { useForm, usePage } from '@inertiajs/react'
import Layout from '../../components/Layout.js'
import PostForm, { type PostFormValues } from '../../components/PostForm.js'

type EditPageProps = {
  post: PostFormValues | null
  postId: number
  errors?: Record<string, string>
}

export default function Edit() {
  const { post, postId, errors = {} } = usePage<EditPageProps>().props

  const form = useForm<PostFormValues>({
    title: post?.title ?? '',
    excerpt: post?.excerpt ?? '',
    body: post?.body ?? ''
  })

  const handleSubmit = (data: PostFormValues) => {
    form.setData(data)
    form.put(`/posts/${postId}`)
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
        <div className="mx-auto mt-12 max-w-xl rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-zinc-200">
          <h2 className="text-2xl font-semibold text-zinc-900 mb-3">Post Not Found</h2>
          <p className="text-zinc-500">{errors.message ?? 'The requested post could not be found.'}</p>
          <button
            onClick={() => window.history.back()}
            className="mt-6 inline-flex items-center justify-center rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800"
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
