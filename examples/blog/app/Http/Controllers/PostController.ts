import { Context, parseRequestPayload, formatValidationErrors } from '@guren/server'
import Controller from './Controller.js'
import type { InferInertiaProps } from '@guren/server'
import { Post } from '../../Models/Post.js'
import { PostPayloadSchema, PostFormSchema } from '../Validators/PostValidator.js'

export default class PostController extends Controller {
  async index(ctx: Context) {
    const posts = await Post.all()
    return this.inertiaWithAuth('posts/Index', { posts }, { url: ctx.req.path, title: 'Posts | Guren Blog' })
  }

  async show(ctx: Context): Promise<Response> {
    const id = Number(ctx.req.param('id'))
    const post = await Post.find(id)

    if (!post) {
      return this.json({ message: 'Post not found' }, { status: 404 })
    }

    return this.inertiaWithAuth('posts/Show', { post }, { url: ctx.req.path, title: `${post.title} | Guren Blog` })
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

    try {
      const post = await Post.create(result.data)
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
      await Post.update({ id }, result.data)
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
