import {
  type InertiaResponse,
  type ResolvedSharedInertiaProps,
  Controller,
  HttpException,
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
type PostEditInertiaProps = ResolvedSharedInertiaProps & {
  post: import('../Validators/PostValidator.js').PostFormData
  postId: number
  cover: import('@guren/core').AttachmentData | null
}
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
    const withCovers = await Post.withAttachments(result.data, ['cover'])
    const data = withCovers.map((post) => new PostResource(post).toJSON())
    const pagination = { meta: paginator.meta(), links: paginator.links() }
    return this.inertia(pages.posts.Index, { data, pagination }, { title: 'Posts | Guren Blog' })
  }

  async show(): Promise<InertiaResponse<'posts/Show', PostShowInertiaProps> | Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')
    // withAttachments maps records 1:1, so the destructured entry always exists.
    const [withCover] = await Post.withAttachments([post], ['cover'])
    const resource = new PostResource(withCover!).toJSON()
    return this.inertia(pages.posts.Show, { post: resource }, { title: `${post.title} | Guren Blog` })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {}, { title: 'New Post | Guren Blog' })
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const authUser = await this.auth.userOrFail<UserRecord>()

    const post = await Post.create({ ...data, authorId: authUser.id })

    if (post) {
      // Invalidate and announce before the attach: a rejected cover throws,
      // and the created post must not be left uncached and unannounced.
      const cacheService = this.#cacheService()
      await cacheService.invalidatePost(post.id)
      await this.make('events').emit(new PostCreated(post, authUser))

      const cover = await this.file('cover')
      if (cover) {
        // Validation (image: 'require') and thumbnail generation happen here;
        // a non-image answers 422 with the error keyed on 'cover'.
        await Post.attach(post.id, 'cover', cover)
      }
    }

    return this.redirect(post?.id ? `/posts/${post.id}` : '/posts')
  }

  async edit(): Promise<InertiaResponse<'posts/Edit', PostEditInertiaProps> | Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id) as BoundPost
    const formPost = PostFormSchema.parse(post)
    const [withCover] = await Post.withAttachments([post], ['cover'])

    return this.inertia(
      pages.posts.Edit,
      { post: formPost, postId: post.id, cover: withCover!.cover },
      { title: `Edit ${formPost.title} | Guren Blog` },
    )
  }

  async update(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id) as BoundPost
    const data = await this.validateBody(PostPayloadSchema)

    await Post.update({ id: post.id }, { ...data, authorId: post.authorId })

    // Invalidate before the attach: a rejected cover throws after the row is
    // already updated, and the cached list must not keep the old fields.
    const cacheService = this.#cacheService()
    await cacheService.invalidatePost(post.id)

    const cover = await this.file('cover')
    if (cover) {
      // hasOne replaces: the previous cover row and its stored objects are
      // purged before the new one is written.
      await Post.attach(post.id, 'cover', cover)
    }

    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id) as BoundPost

    const authUser = await this.auth.userOrFail<UserRecord>()
    if (post.authorId !== authUser.id) {
      throw new HttpException(403, 'You can only delete your own posts.')
    }

    // The polymorphic attachable pair cannot carry a foreign key, so there is
    // no database cascade — purge explicitly, objects first, rows after.
    await Post.purgeAttachments(post.id)
    await Post.delete({ id: post.id })

    const cacheService = this.#cacheService()
    await cacheService.invalidatePost(post.id)

    return this.redirect('/posts')
  }
}

