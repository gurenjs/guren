import { Context, parseRequestPayload, formatValidationErrors } from '@guren/server'
import Controller from './Controller.js'
import type { InferInertiaProps } from '@guren/server'
import { Post, type PostRecord } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { PostPayloadSchema, PostFormSchema } from '../Validators/PostValidator.js'
import { z } from 'zod'

type AuthorSummary = Pick<UserRecord, 'id' | 'name'>
type PostWithAuthor = PostRecord & { author: AuthorSummary | null }

export default class PostController extends Controller {
  async index(ctx: Context) {
    const rawPosts = await Post.with('author')
    const posts: PostWithAuthor[] = rawPosts.map((post) => ({
      ...post,
      author: toAuthorSummary(post.author),
    }))

    return this.inertiaWithAuth('posts/Index', { posts }, { url: ctx.req.path, title: 'Posts | Guren Blog' })
  }

  async show(ctx: Context): Promise<Response> {
    const id = Number(ctx.req.param('id'))
    const [post] = await Post.with('author', { id })

    if (!post) {
      return this.json({ message: 'Post not found' }, { status: 404 })
    }

    const formattedPost: PostWithAuthor = {
      ...post,
      author: toAuthorSummary(post.author),
    }

    return this.inertiaWithAuth('posts/Show', { post: formattedPost }, { url: ctx.req.path, title: `${formattedPost.title} | Guren Blog` })
  }

  async create(ctx: Context): Promise<Response> {
    return this.inertiaWithAuth('posts/New', {}, { url: ctx.req.path, title: 'New Post | Guren Blog' })
  }

  async store(ctx: Context): Promise<Response> {
    const payload = await parseRequestPayload(ctx)
    const result = PostPayloadSchema.safeParse(payload)

    if (!result.success) {
      const errors = formatValidationErrors(result.error)
      return this.inertiaWithAuth('posts/New', { errors }, { status: 422 })
    }

    const userResult = CurrentUserSchema.safeParse(await this.auth.user())
    if (!userResult.success) {
      return this.inertiaWithAuth('posts/New', { errors: { message: 'You must be signed in to create posts.' } }, { status: 401 })
    }

    try {
      const post = await Post.create({ ...result.data, authorId: userResult.data.id })
      const redirectTo = post?.id ? `/posts/${post.id}` : '/posts'
      return this.redirect(redirectTo)
    } catch (error) {
      console.error('Failed to create post:', error)
      return this.inertiaWithAuth('posts/New', { errors: { message: 'Failed to create post.' } }, { status: 500 })
    }
  }

  async edit(ctx: Context): Promise<Response> {
    const id = Number(ctx.req.param('id'))
    const post = await Post.find(id)

    if (!post) {
      return this.inertiaWithAuth('posts/Edit', { errors: { message: 'Post not found.' }, post: null, postId: id }, { status: 404 })
    }

    const formPostResult = PostFormSchema.safeParse(post)

    if (!formPostResult.success) {
      console.error('Post failed validation when preparing edit form:', formPostResult.error)
      return this.json({ message: 'Failed to load post.' }, { status: 500 })
    }

    const formPost = formPostResult.data

    return this.inertiaWithAuth('posts/Edit', { post: formPost, postId: id }, { url: ctx.req.path, title: `Edit ${formPost.title} | Guren Blog` })
  }

  async update(ctx: Context): Promise<Response> {
    const id = Number(ctx.req.param('id'))
    const post = await Post.find(id)

    if (!post) {
      return this.json({ message: 'Post not found' }, { status: 404 })
    }

    const payload = await parseRequestPayload(ctx)
    const result = PostPayloadSchema.safeParse(payload)

    if (!result.success) {
      const errors = formatValidationErrors(result.error)

      const formPostResult = PostFormSchema.safeParse(post)

      if (!formPostResult.success) {
        console.error('Post failed validation when re-rendering edit form:', formPostResult.error)
        return this.inertiaWithAuth('posts/Edit', { errors: { message: 'Failed to load post.' }, post: null, postId: id }, { status: 500 })
      }

      return this.inertiaWithAuth('posts/Edit', { post: formPostResult.data, postId: id, errors }, { status: 422 })
    }

    try {
      await Post.update({ id }, { ...result.data, authorId: post.authorId })
      return this.redirect(`/posts/${id}`)
    } catch (error) {
      console.error('Failed to update post:', error)
      const formPostResult = PostFormSchema.safeParse(post)

      if (formPostResult.success) {
        return this.inertiaWithAuth('posts/Edit', { post: formPostResult.data, postId: id, errors: { message: 'Failed to update post.' } }, { status: 500 })
      }

      return this.inertiaWithAuth('posts/Edit', { errors: { message: 'Failed to update post.' }, post: null, postId: id }, { status: 500 })
    }
  }
}

type PostControllerInstance = InstanceType<typeof PostController>

export type PostsIndexPageProps = InferInertiaProps<Awaited<ReturnType<PostControllerInstance['index']>>>
export type PostShowPageProps = InferInertiaProps<Awaited<ReturnType<PostControllerInstance['show']>>>

const AuthorSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
})

const CurrentUserSchema = z.object({ id: z.number() })

function toAuthorSummary(author: unknown): AuthorSummary | null {
  if (author == null) {
    return null
  }

  const result = AuthorSummarySchema.safeParse(author)
  return result.success ? result.data : null
}
