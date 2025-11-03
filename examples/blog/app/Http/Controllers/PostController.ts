import { Context, parseRequestPayload, formatValidationErrors } from '@guren/server'
import Controller from './Controller.js'
import type { ControllerInertiaProps } from '@guren/server'
import { Post, type PostWithAuthor } from '../../Models/Post.js'
import { PostPayloadSchema, PostFormSchema } from '../Validators/PostValidator.js'

export default class PostController extends Controller {
  async index(ctx: Context) {
    const posts = await Post.with('author')

    return this.inertiaWithAuth('posts/Index', { posts }, { url: ctx.req.path, title: 'Posts | Guren Blog' })
  }

  async show(ctx: Context): Promise<Response> {
    const id = Number(ctx.req.param('id'))
    const [post] = await Post.with('author', { id })

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

    const authUser = (await this.auth.user()) as { id?: number } | null

    if (!authUser?.id) {
      return this.inertiaWithAuth('posts/New', { errors: { message: 'You must be signed in to create posts.' } }, { status: 401 })
    }

    try {
      const post = await Post.create({ ...result.data, authorId: authUser.id })
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

      const formPost = formPostResult.data
      return this.inertiaWithAuth(
        'posts/Edit',
        { post: formPost, postId: id, errors },
        { status: 422, url: ctx.req.path, title: `Edit ${formPost.title} | Guren Blog` },
      )
    }

    try {
      await Post.update({ id }, { ...result.data, authorId: post.authorId })
      return this.redirect(`/posts/${id}`)
    } catch (error) {
      console.error('Failed to update post:', error)

      return this.inertiaWithAuth('posts/Edit', { errors: { message: 'Failed to update post.' }, post: result.data, postId: id }, { status: 500 })
    }
  }
}

type InertiaPropsFor<Action extends keyof PostController> = ControllerInertiaProps<PostController, Action>

type AuthProps = InertiaPropsFor<'index'> extends { auth: infer T } ? T : { user: unknown }

export type PostsIndexPageProps = { posts: PostWithAuthor[]; auth: AuthProps }
export type PostShowPageProps = { post: PostWithAuthor; auth: AuthProps }
