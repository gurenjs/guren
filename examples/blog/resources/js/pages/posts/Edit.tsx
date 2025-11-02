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
        <div className="mx-auto mt-12 max-w-xl rounded-2xl border border-[#F4B0B0] bg-white p-8 text-center shadow-lg shadow-[#B71C1C]/10">
          <h2 className="text-2xl font-semibold text-[#B71C1C] mb-3">投稿が見つかりません</h2>
          <p className="text-[#6B1B1B]">{errors.message ?? '指定された投稿を表示できません。'}</p>
          <button
            onClick={() => window.history.back()}
            className="mt-6 inline-flex items-center rounded-xl bg-linear-to-r from-[#B71C1C] to-[#8F1111] px-5 py-2.5 text-white shadow-lg shadow-[#B71C1C]/30 transition-all duration-200 hover:from-[#C92A2A] hover:to-[#7A0F0F]"
          >
            戻る
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
