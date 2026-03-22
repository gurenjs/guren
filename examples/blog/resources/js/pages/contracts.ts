import type { ValidationErrors, PaginatedPageProps } from '@guren/core'
import type { PostPageResource } from '../../../app/Http/Controllers/PostController.js'
import type { PostFormValues } from '../components/PostForm.js'

export type LoginPageProps = {
  email?: string
  errors?: ValidationErrors<'email' | 'password'>
}

export type PostsIndexPageProps = PaginatedPageProps<PostPageResource>

export type PostEditPageProps = {
  post: PostFormValues | null
  postId: number
  errors?: ValidationErrors<keyof PostFormValues>
}
