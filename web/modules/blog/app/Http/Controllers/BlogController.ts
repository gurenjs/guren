import { Controller } from '@guren/core'
import { z } from 'zod'
import { pageTitle } from '../../../../../config/site.js'
import { Post, type PostRecord } from '../../Models/Post.js'
import { pages } from '@/.guren/pages.gen.js'

const SlugParamSchema = z.object({
  slug: z.string().min(1),
})

export function isPublished(post: PostRecord, now: Date = new Date()): boolean {
  return post.publishedAt !== null && post.publishedAt.getTime() <= now.getTime()
}

function toSummary(post: PostRecord) {
  return {
    slug: post.slug,
    title: post.title,
    description: post.description,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
  }
}

export default class BlogController extends Controller {
  async index(): Promise<Response> {
    const records = await Post.all()
    const posts = records
      .filter((post) => isPublished(post))
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
      .map(toSummary)

    return this.inertia(
      pages.blog.Index,
      { posts },
      { url: this.request.path, title: pageTitle('Blog') },
    )
  }

  async show(): Promise<Response> {
    const { slug } = this.validateParams(SlugParamSchema)
    const record = await Post.where({ slug }).first()
    const visible = record !== null && (isPublished(record) || (await this.viewerAuthenticated()))

    if (!record || !visible) {
      return this.inertia(
        pages.blog.Show,
        { post: null },
        { url: this.request.path, title: pageTitle('Post not found'), status: 404 },
      )
    }

    return this.inertia(
      pages.blog.Show,
      {
        post: {
          ...toSummary(record),
          bodyHtml: record.bodyHtml,
        },
      },
      { url: this.request.path, title: pageTitle(record.title) },
    )
  }

  // Read through the auth context key directly instead of `this.auth`: the
  // public blog must keep working (as guest) even when no auth middleware is
  // attached, where the `auth` accessor throws.
  private async viewerAuthenticated(): Promise<boolean> {
    const auth = this.ctx.get('guren:auth') as { check(): Promise<boolean> } | undefined
    return auth ? auth.check() : false
  }
}
