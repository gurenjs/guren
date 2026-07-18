import {
  type InertiaResponse,
  type ResolvedSharedInertiaProps,
  Controller,
  paginate,
  type PaginatedPageProps,
} from '@guren/core'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { PostPayloadSchema, PostFormSchema, PageQuerySchema, PostIdParamSchema } from '../Validators/PostValidator.js'
import { PostCreated } from '../../Events/PostCreated.js'
import { PostCacheService, POSTS_PAGE_SIZE } from '../../Services/PostCacheService.js'
import { pages } from '@/.guren/pages.gen'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'

export type PostPageResource = PostResourceData
type PostsIndexInertiaProps = ResolvedSharedInertiaProps & PaginatedPageProps<PostPageResource>
type PostShowInertiaProps = ResolvedSharedInertiaProps & { post: PostPageResource }
type PostEditInertiaProps = ResolvedSharedInertiaProps & { post: import('../Validators/PostValidator.js').PostFormData; postId: number }
type BoundPost = Awaited<ReturnType<typeof Post.findOrFail>> & { id: number; authorId: number }

export default class PostController extends Controller {
  #cacheService(): PostCacheService {
    return new PostCacheService(this.make('cache'))
  }

  async index(): Promise<InertiaResponse<'posts/Index', PostsIndexInertiaProps> | Response> {
    const { page } = this.validateQuery(PageQuerySchema)
    const requestedPage = page ?? 1

    const cacheService = this.#cacheService()
    const result = await cacheService.getPaginatedPosts(requestedPage, POSTS_PAGE_SIZE)
    const paginator = paginate(result, { path: this.request.path ?? '/' })
    const data = result.data.map((post) => new PostResource(post).toJSON())
    const pagination = { meta: paginator.meta(), links: paginator.links() }
    return this.inertia(pages.posts.Index, { data, pagination }, { url: this.request.url ?? this.request.path, title: 'Posts | Guren Blog' })
  }

  async show(): Promise<InertiaResponse<'posts/Show', PostShowInertiaProps> | Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')
    const resource = new PostResource(post).toJSON()
    const payload = {
      id: resource.id,
      title: resource.title,
      excerpt: resource.excerpt,
      body: resource.body,
      author: resource.author,
      notificationArtifactPath: resource.notificationArtifactPath,
      broadcastChannels: resource.broadcastChannels,
    }
    return this.inertia(pages.posts.Show, { post: payload }, { url: this.request.path, title: `${post.title} | Guren Blog` })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {}, { url: this.request.path, title: 'New Post | Guren Blog' })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const authUser = await this.auth.userOrFail<UserRecord>()

    const post = await Post.create({ ...data, authorId: authUser.id })

    if (post) {
      const cacheService = this.#cacheService()
      await cacheService.invalidatePost(post.id)
      await this.make('events').emit(new PostCreated(post, authUser))
    }

    return this.redirect(post?.id ? `/posts/${post.id}` : '/posts')
  }

  async edit(): Promise<InertiaResponse<'posts/Edit', PostEditInertiaProps> | Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id) as BoundPost
    const formPost = PostFormSchema.parse(post)

    return this.inertia(pages.posts.Edit, { post: formPost, postId: post.id }, { url: this.request.path, title: `Edit ${formPost.title} | Guren Blog` })
  }

  async update(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id) as BoundPost
    const data = await this.validateBody(PostPayloadSchema)

    await Post.update({ id: post.id }, { ...data, authorId: post.authorId })

    const cacheService = this.#cacheService()
    await cacheService.invalidatePost(post.id)

    return this.redirect(`/posts/${post.id}`)
  }
}

