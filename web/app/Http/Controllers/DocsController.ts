import { Controller, Context } from '@guren/server'
import {
  docsService,
  normalizeDocCategory,
  normalizeDocSlug,
} from '../../Services/DocsService.js'

export default class DocsController extends Controller {
  async index(ctx: Context): Promise<Response> {
    const categories = await docsService.listDocs()

    return this.inertia(
      'Docs/Index',
      { categories },
      { url: ctx.req.path, title: 'Documentation' },
    )
  }

  async show(ctx: Context): Promise<Response> {
    const categoryParam = ctx.req.param('category') || undefined
    const slugParam = ctx.req.param('slug') || undefined
    const normalizedCategory = normalizeDocCategory(categoryParam)
    const normalizedSlug = normalizeDocSlug(slugParam)
    const [categories, doc] = await Promise.all([
      docsService.listDocs(),
      docsService.getDoc(categoryParam, slugParam),
    ])

    const pageTitle = doc ? `${doc.title} – Documentation` : 'Document Not Found'
    const active = doc
      ? { category: doc.category, slug: doc.slug }
      : normalizedCategory && normalizedSlug
        ? { category: normalizedCategory, slug: normalizedSlug }
        : undefined

    return this.inertia(
      'Docs/Show',
      { categories, doc, active },
      {
        url: ctx.req.path,
        title: pageTitle,
        status: doc ? 200 : 404,
      },
    )
  }
}
