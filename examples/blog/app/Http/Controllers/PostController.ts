import {
  type InertiaResponse,
  type ResolvedSharedInertiaProps,
  type InferInertiaProps,
  Controller,
} from '@guren/server'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { PostPayloadSchema, PostFormSchema, PageQuerySchema, PostIdParamSchema } from '../Validators/PostValidator.js'
import type { PaginationMeta, WithRelations } from '@guren/orm'
import { getEventManager } from '../../Providers/EventServiceProvider.js'
import { PostCreated } from '../../Events/PostCreated.js'
import { getPostCacheService } from '../../Services/PostCacheService.js'

type PostWithAuthor = WithRelations<typeof Post, 'author'>
type PostsIndexInertiaProps = ResolvedSharedInertiaProps & { posts: PostWithAuthor[]; pagination: PostsPagination }
type PostShowInertiaProps = ResolvedSharedInertiaProps & { post: PostWithAuthor }
export type PostsPagination = PaginationMeta & { basePath: string }

export default class PostController extends Controller {
  async index(): Promise<InertiaResponse<'posts/Index', PostsIndexInertiaProps> | Response> {
    const { page } = this.validateQuery(PageQuerySchema)
    const requestedPage = page ?? 1

    const cacheService = getPostCacheService()
    const { posts, meta } = await cacheService.getPaginatedPosts(requestedPage, 6)

    const pagination: PostsPagination = { ...meta, basePath: this.request.path ?? '/' }
    return this.inertia('posts/Index', { posts, pagination }, { url: this.request.url ?? this.request.path, title: 'Posts | Guren Blog' })
  }

  async show(): Promise<InertiaResponse<'posts/Show', PostShowInertiaProps> | Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')

    return this.inertia('posts/Show', { post }, { url: this.request.path, title: `${post.title} | Guren Blog` })
  }

  async create(): Promise<Response> {
    return this.inertia('posts/New', {}, { url: this.request.path, title: 'New Post | Guren Blog' })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const authUser = await this.auth.userOrFail<UserRecord>()

    const post = await Post.create({ ...data, authorId: authUser.id })

    if (post) {
      const cacheService = getPostCacheService()
      await cacheService.invalidatePost(post.id)
      await getEventManager().emit(new PostCreated(post, authUser))
    }

    return this.redirect(post?.id ? `/posts/${post.id}` : '/posts')
  }

  async edit(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    const formPost = PostFormSchema.parse(post)

    return this.inertia('posts/Edit', { post: formPost, postId: id }, { url: this.request.path, title: `Edit ${formPost.title} | Guren Blog` })
  }

  async update(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    const data = await this.validateBody(PostPayloadSchema)

    await Post.update({ id }, { ...data, authorId: post.authorId })

    const cacheService = getPostCacheService()
    await cacheService.invalidatePost(id)

    return this.redirect(`/posts/${id}`)
  }
}

export type PostsIndexPageProps = InferInertiaProps<ReturnType<PostController['index']>>
export type PostShowPageProps = InferInertiaProps<ReturnType<PostController['show']>>
