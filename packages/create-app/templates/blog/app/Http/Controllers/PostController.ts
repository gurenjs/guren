import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { PostIdParamSchema, PostPayloadSchema, PostSearchSchema, ListPostsQuerySchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.newQuery()
      .with('author')
      .orderBy('id', 'desc')
      .paginate({ page, perPage: 10 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  // Serves the HTTP QUERY route `posts.search` — a safe read that carries its
  // criteria in a JSON body. Matches posts with any keyword in title or
  // excerpt; `%` and `_` in a keyword act as SQL LIKE wildcards, which this
  // starter treats as a feature. Each keyword's OR pair is grouped in a
  // `where(callback)`, so AND filters added later (a published flag, tenancy)
  // apply to every match instead of being OR'd away.
  async search(): Promise<Response> {
    const { keywords, limit } = await this.validateBody(PostSearchSchema)

    const query = Post.newQuery().with('author')
    query.where((q) => {
      for (const keyword of keywords) {
        const pattern = `%${keyword}%`
        q.orWhere('title', 'like', pattern)
        q.orWhere('excerpt', 'like', pattern)
      }
    })
    const posts = await query.orderBy('id', 'desc').limit(limit).get()

    return this.json({ data: PostResource.collection(posts) })
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
    })
  }

  async create(): Promise<Response> {
    await this.authorize('create', Post)
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    await this.authorize('create', Post)
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(PostPayloadSchema)
    // forceCreate, because `authorId` is deliberately absent from Post.fillable:
    // it comes from the session, and a request must never be able to set it.
    const post = await Post.forceCreate({ ...data, authorId: author.id })

    return this.redirect(post?.id ? `/posts/${post.id}` : '/posts')
  }

  async edit(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    await this.authorize('update', [Post, post])

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    await this.authorize('update', [Post, post])

    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)

    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    await this.authorize('delete', [Post, post])

    await Post.delete({ id: post.id })

    return this.redirect('/posts')
  }
}
