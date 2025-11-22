import {
  parseRequestPayload,
  formatValidationErrors,
  type InertiaResponse,
  type ResolvedSharedInertiaProps,
  type InferInertiaProps,
  Controller,
} from '@guren/server'
import { Post, type PostWithAuthor } from '../../Models/Post.js'
import { PostPayloadSchema, PostFormSchema, PageQuerySchema, PostIdParamSchema } from '../Validators/PostValidator.js'
import type { PaginationMeta } from '@guren/orm'
import { desc, eq, count } from 'drizzle-orm'
import { getDatabase } from '../../../config/database.ts'
import { posts as postsTable, users } from '../../../db/schema.ts'

type PostsIndexInertiaProps = ResolvedSharedInertiaProps & { posts: PostWithAuthor[]; pagination: PostsPagination }
type PostShowInertiaProps = ResolvedSharedInertiaProps & { post: PostWithAuthor }
export type PostsPagination = PaginationMeta & { basePath: string }

export default class PostController extends Controller {
  async index(): Promise<InertiaResponse<'posts/Index', PostsIndexInertiaProps> | Response> {
    const postsPerPage = 6
    const pageResult = PageQuerySchema.safeParse({ page: this.request.query('page') })

    if (!pageResult.success) {
      return this.json({ message: 'Invalid page parameter.' }, { status: 422 })
    }

    const db = await getDatabase()
    const requestedPage = pageResult.data.page ?? 1
    const currentPage = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.floor(requestedPage) : 1

    const [{ value: totalRaw } = { value: 0 }] = await db
      .select({ value: count(postsTable.id) })
      .from(postsTable)

    const total = typeof totalRaw === 'bigint' ? Number(totalRaw) : Number(totalRaw ?? 0)
    const totalPages = total === 0 ? 1 : Math.max(1, Math.ceil(total / postsPerPage))
    const page = Math.min(currentPage, totalPages)
    const offset = (page - 1) * postsPerPage

    const rows = await db
      .select({
        id: postsTable.id,
        title: postsTable.title,
        excerpt: postsTable.excerpt,
        body: postsTable.body,
        authorId: postsTable.authorId,
        author: {
          id: users.id,
          name: users.name,
        },
      })
      .from(postsTable)
      .leftJoin(users, eq(users.id, postsTable.authorId))
      .orderBy(desc(postsTable.id))
      .offset(offset)
      .limit(postsPerPage)

    const postList: PostWithAuthor[] = rows.map((row): PostWithAuthor => ({
      id: row.id,
      title: row.title,
      excerpt: row.excerpt,
      body: row.body,
      authorId: row.authorId,
      author: row.author?.id ? { id: row.author.id, name: row.author.name } : null,
    }))

    const meta: PaginationMeta = {
      total,
      perPage: postsPerPage,
      currentPage: page,
      totalPages,
      hasMore: page < totalPages,
      from: total === 0 ? 0 : offset + 1,
      to: total === 0 ? 0 : Math.min(total, offset + postList.length),
    }

    const pagination: PostsPagination = {
      ...meta,
      basePath: this.request.path ?? '/',
    }

    const url = this.request.url ?? this.request.path
    return this.inertia('posts/Index', { posts: postList, pagination }, { url, title: 'Posts | Guren Blog' })
  }

  async show(): Promise<InertiaResponse<'posts/Show', PostShowInertiaProps> | Response> {
    const paramsResult = PostIdParamSchema.safeParse({ id: this.request.param('id') })

    if (!paramsResult.success) {
      return this.json({ message: 'Invalid post id.' }, { status: 400 })
    }

    const { id } = paramsResult.data
    const [post] = await Post.with('author', { id })

    if (!post) {
      return this.json({ message: 'Post not found' }, { status: 404 })
    }

    return this.inertia('posts/Show', { post }, { url: this.request.path, title: `${post.title} | Guren Blog` })
  }

  async create(): Promise<Response> {
    return this.inertia('posts/New', {}, { url: this.request.path, title: 'New Post | Guren Blog' })
  }

  async store(): Promise<Response> {
    const payload = await parseRequestPayload(this.ctx)
    const result = PostPayloadSchema.safeParse(payload)

    if (!result.success) {
      const errors = formatValidationErrors(result.error)
      return this.inertia('posts/New', { errors }, { status: 422 })
    }

    const authUser = (await this.auth.user()) as { id?: number } | null

    if (!authUser?.id) {
      return this.inertia('posts/New', { errors: { message: 'You must be signed in to create posts.' } }, { status: 401 })
    }

    try {
      const post = await Post.create({ ...result.data, authorId: authUser.id })
      const redirectTo = post?.id ? `/posts/${post.id}` : '/posts'
      return this.redirect(redirectTo)
    } catch (error) {
      console.error('Failed to create post:', error)
      return this.inertia('posts/New', { errors: { message: 'Failed to create post.' } }, { status: 500 })
    }
  }

  async edit(): Promise<Response> {
    const paramsResult = PostIdParamSchema.safeParse({ id: this.request.param('id') })

    if (!paramsResult.success) {
      return this.inertia('posts/Edit', { errors: { message: 'Invalid post id.' }, post: null, postId: 0 }, { status: 400 })
    }

    const { id } = paramsResult.data
    const post = await Post.find(id)

    if (!post) {
      return this.inertia('posts/Edit', { errors: { message: 'Post not found.' }, post: null, postId: id }, { status: 404 })
    }

    const formPostResult = PostFormSchema.safeParse(post)

    if (!formPostResult.success) {
      console.error('Post failed validation when preparing edit form:', formPostResult.error)
      return this.json({ message: 'Failed to load post.' }, { status: 500 })
    }

    const formPost = formPostResult.data

    return this.inertia('posts/Edit', { post: formPost, postId: id }, { url: this.request.path, title: `Edit ${formPost.title} | Guren Blog` })
  }

  async update(): Promise<Response> {
    const paramsResult = PostIdParamSchema.safeParse({ id: this.request.param('id') })

    if (!paramsResult.success) {
      return this.json({ message: 'Invalid post id.' }, { status: 400 })
    }

    const { id } = paramsResult.data
    const post = await Post.find(id)

    if (!post) {
      return this.json({ message: 'Post not found' }, { status: 404 })
    }

    const payload = await parseRequestPayload(this.ctx)
    const result = PostPayloadSchema.safeParse(payload)

    if (!result.success) {
      const errors = formatValidationErrors(result.error)

      const formPostResult = PostFormSchema.safeParse(post)

      if (!formPostResult.success) {
        console.error('Post failed validation when re-rendering edit form:', formPostResult.error)
        return this.inertia('posts/Edit', { errors: { message: 'Failed to load post.' }, post: null, postId: id }, { status: 500 })
      }

      const formPost = formPostResult.data
      return this.inertia(
        'posts/Edit',
        { post: formPost, postId: id, errors },
        { status: 422, url: this.request.path, title: `Edit ${formPost.title} | Guren Blog` },
      )
    }

    try {
      await Post.update({ id }, { ...result.data, authorId: post.authorId })
      return this.redirect(`/posts/${id}`)
    } catch (error) {
      console.error('Failed to update post:', error)

      return this.inertia('posts/Edit', { errors: { message: 'Failed to update post.' }, post: result.data, postId: id }, { status: 500 })
    }
  }
}

export type PostsIndexPageProps = InferInertiaProps<ReturnType<PostController['index']>>
export type PostShowPageProps = InferInertiaProps<ReturnType<PostController['show']>>
