import { Controller } from '@guren/server'
import {
  docsService,
  normalizeDocCategory,
  normalizeDocSlug,
} from '../../Services/DocsService.js'

export default class DocsController extends Controller {
  async index(): Promise<Response> {
    const categories = await docsService.listDocs()

    return this.inertia(
      'Docs/Index',
      { categories },
      { url: this.request.path, title: 'Documentation' },
    )
  }

  async show(): Promise<Response> {
    const categoryParam = this.request.param('category') || undefined
    const slugParam = this.request.param('slug') || undefined
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
        url: this.request.path,
        title: pageTitle,
        status: doc ? 200 : 404,
      },
    )
  }
}
