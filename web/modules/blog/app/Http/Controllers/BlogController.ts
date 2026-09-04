import { Controller } from '@guren/core'
import { z } from 'zod'
import { pageTitle } from '../../../../../config/site.js'
import { Post, type PostRecord } from '../../Models/Post.js'
import { isPublished, listPublishedPosts } from '../../Services/published-posts.js'
import { PostNotFoundPage, ShowPage } from '../../View/ShowPage.js'
import { pages } from '@/.guren/pages.gen.js'

const SlugParamSchema = z.object({
  slug: z.string().min(1),
})

/** The summary columns the list view needs — see index(). */
type PostSummarySource = Pick<PostRecord, 'slug' | 'title' | 'description' | 'publishedAt'>

function toSummary(post: PostSummarySource) {
  return {
    slug: post.slug,
    title: post.title,
    description: post.description,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
  }
}

export default class BlogController extends Controller {
  async index(): Promise<Response> {
    const posts = (await listPublishedPosts()).map(toSummary)

    return this.inertia(
      pages.blog.Index,
      { posts },
      { title: pageTitle('Blog') },
    )
  }

  // Server-rendered HTML rather than Inertia: the article body would otherwise
  // ship twice (escaped `__INERTIA_PAGE__` JSON and SSR HTML) for a page that
  // hydrates nothing.
  async show(): Promise<Response> {
    const { slug } = this.validateParams(SlugParamSchema)
    const record = await Post.where({ slug }).first()
    const visible = record !== null && (isPublished(record) || (await this.viewerAuthenticated()))

    if (!record || !visible) {
      return this.view(PostNotFoundPage, {}, { status: 404 })
    }

    return this.view(ShowPage, {
      post: {
        ...toSummary(record),
        bodyHtml: record.bodyHtml,
      },
    })
  }

  // The context key directly rather than `this.auth`, whose accessor throws
  // when no auth middleware is attached — the public blog must still serve.
  private async viewerAuthenticated(): Promise<boolean> {
    const auth = this.ctx.get('guren:auth') as { check(): Promise<boolean> } | undefined
    return auth ? auth.check() : false
  }
}
