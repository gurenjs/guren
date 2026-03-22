import { useForm } from '@inertiajs/react'
import PostForm, { type PostFormValues } from '../../components/PostForm.js'

interface Props {}

export default function New({}: Props) {
  const form = useForm<PostFormValues>({
    title: '',
    excerpt: '',
    body: ''
  })

  const handleSubmit = (data: PostFormValues) => {
    form.setData(data)
    form.post('/posts', {
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
