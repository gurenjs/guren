import { Controller } from '@guren/core'
import { z } from 'zod'
import { pageTitle } from '../../../../../../config/site.js'
import { Post, type PostRecord } from '../../../Models/Post.js'
import { renderPostMarkdown } from '../../../Services/PostRenderer.js'
import { uniqueSlug } from '../../../Services/slug.js'
import { pages } from '@/.guren/pages.gen.js'

const PostPayloadSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().optional(),
  bodyMarkdown: z.string().min(1),
})

const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

function toAdminSummary(post: PostRecord) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    publishedAt: post.publishedAt ? post.publishedAt.toISOString() : null,
    updatedAt: post.updatedAt.toISOString(),
  }
}

async function slugTaken(slug: string): Promise<boolean> {
  return (await Post.where({ slug }).first()) !== null
}

export default class PostsController extends Controller {
  async index(): Promise<Response> {
    const records = await Post.all()
    const posts = records
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toAdminSummary)

    return this.inertia(
      pages.admin.Posts,
      { posts },
      { url: this.request.path, title: pageTitle('Admin') },
    )
  }

  async create(): Promise<Response> {
    return this.inertia(
      pages.admin.PostForm,
      { post: null },
      { url: this.request.path, title: pageTitle('New post') },
    )
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const slug = await uniqueSlug(data.title, slugTaken)
    const bodyHtml = await renderPostMarkdown(data.bodyMarkdown)

    await Post.create({
      slug,
      title: data.title,
      description: data.description || null,
      bodyMarkdown: data.bodyMarkdown,
      bodyHtml,
    })

    return this.redirect('/admin')
  }

  async edit(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    return this.inertia(
      pages.admin.PostForm,
      {
        post: {
          id: post.id,
          slug: post.slug,
          title: post.title,
          description: post.description,
          bodyMarkdown: post.bodyMarkdown,
        },
      },
      { url: this.request.path, title: pageTitle('Edit post') },
    )
  }

  async update(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    await Post.findOrFail(id)
    const data = await this.validateBody(PostPayloadSchema)
    const bodyHtml = await renderPostMarkdown(data.bodyMarkdown)

    // The slug is intentionally kept stable on update so published URLs
    // never break when a title is edited.
    await Post.update(
      { id },
      {
        title: data.title,
        description: data.description || null,
        bodyMarkdown: data.bodyMarkdown,
        bodyHtml,
        updatedAt: new Date(),
      },
    )

    return this.redirect('/admin')
  }

  async destroy(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    await Post.findOrFail(id)
    await Post.where({ id }).delete()

    return this.redirect('/admin')
  }

  async togglePublish(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    await Post.update(
      { id },
      {
        publishedAt: post.publishedAt ? null : new Date(),
        updatedAt: new Date(),
      },
    )

    return this.redirect('/admin')
  }
}
