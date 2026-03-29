import { useForm } from '@inertiajs/react'
import PostForm, { type PostFormValues } from '../../components/PostForm.js'
import { route } from '../../../../.guren/routes.gen'

export default function New() {
  const form = useForm<PostFormValues>({
    title: '',
    excerpt: '',
    body: ''
  })

  const handleSubmit = (data: PostFormValues) => {
    form.transform(() => data)
    form.post(route('posts.store'), {
      onSuccess: () => form.reset()
    })
  }

  const handleCancel = () => {
    if (window.confirm('作成をキャンセルしますか？入力した内容は失われます。')) {
      form.reset()
      window.history.back()
    }
  }

  return (
    <PostForm
      mode="create"
      form={form}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
    />
  )
}
