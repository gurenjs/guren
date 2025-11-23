import { Controller } from '@guren/server'
import {
  DEFAULT_DOC_LOCALE,
  DOC_LOCALE_OPTIONS,
  docsService,
  normalizeDocCategory,
  normalizeDocSlug,
} from '../../Services/DocsService.js'

type DocLocale = (typeof DOC_LOCALE_OPTIONS)[number]['code']

export default class DocsController extends Controller {
  async index(): Promise<Response> {
    return this.#renderIndex(DEFAULT_DOC_LOCALE)
  }

  async indexJa(): Promise<Response> {
    return this.#renderIndex('ja')
  }

  async show(): Promise<Response> {
    const categoryParam = this.request.param('category') || undefined
    const slugParam = this.request.param('slug') || undefined

    return this.#renderShow({ categoryParam, slugParam, locale: DEFAULT_DOC_LOCALE })
  }

  async showJa(): Promise<Response> {
    const categoryParam = this.request.param('category') || undefined
    const slugParam = this.request.param('slug') || undefined

    return this.#renderShow({ categoryParam, slugParam, locale: 'ja' })
  }

  async #renderIndex(locale: DocLocale): Promise<Response> {
    const categories = await docsService.listDocs(locale)
    const locales = this.#localeLinks(locale)
    const basePath = this.#basePathForLocale(locale)

    return this.inertia(
      'Docs/Index',
      { categories, locale, locales, basePath },
      {
        url: this.request.path,
        title: this.#titleForLocale(locale),
      },
    )
  }

  async #renderShow({
    categoryParam,
    slugParam,
    locale,
  }: {
    categoryParam: string | undefined
    slugParam: string | undefined
    locale: DocLocale
  }): Promise<Response> {
    const normalizedCategory = normalizeDocCategory(categoryParam)
    const normalizedSlug = normalizeDocSlug(slugParam)
    const [categories, doc] = await Promise.all([
      docsService.listDocs(locale),
      docsService.getDoc(categoryParam, slugParam, locale),
    ])

    const pageTitle = doc ? `${doc.title} – Documentation` : this.#notFoundTitle(locale)
    const active = doc
      ? { category: doc.category, slug: doc.slug }
      : normalizedCategory && normalizedSlug
        ? { category: normalizedCategory, slug: normalizedSlug }
        : undefined
    const locales = this.#localeLinks(locale, { category: normalizedCategory, slug: normalizedSlug })
    const basePath = this.#basePathForLocale(locale)

    return this.inertia(
      'Docs/Show',
      { categories, doc, active, locale, locales, basePath },
      {
        url: this.request.path,
        title: pageTitle,
        status: doc ? 200 : 404,
      },
    )
  }

  #basePathForLocale(locale: DocLocale): string {
    return locale === DEFAULT_DOC_LOCALE ? '/docs' : `/docs/${locale}`
  }

  #localeLinks(
    current: DocLocale,
    active?: { category: ReturnType<typeof normalizeDocCategory>; slug: ReturnType<typeof normalizeDocSlug> },
  ) {
    return DOC_LOCALE_OPTIONS.map((option) => {
      const base = this.#basePathForLocale(option.code)
      const path = active?.category && active?.slug ? `${base}/${active.category}/${active.slug}` : base
      return {
        code: option.code,
        label: option.label,
        href: path,
        active: option.code === current,
      }
    })
  }

  #titleForLocale(locale: DocLocale): string {
    if (locale === 'ja') return 'ドキュメント'
    return 'Documentation'
  }

  #notFoundTitle(locale: DocLocale): string {
    if (locale === 'ja') return 'ドキュメントが見つかりません'
    return 'Document Not Found'
  }
}
