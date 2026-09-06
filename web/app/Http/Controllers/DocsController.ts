import { Controller } from '@guren/core'
import { DOCS_CACHE_CONTROL, docsBasePath, pageTitle, type DocLocale } from '../../../config/site.js'
import { DOC_REDIRECTS } from '../../Services/docs-config.js'
import {
  DEFAULT_DOC_LOCALE,
  DOC_LOCALE_OPTIONS,
  docsService,
  normalizeDocCategory,
  normalizeDocSlug,
} from '../../Services/DocsService.js'
import { pages } from '@/.guren/pages.gen.js'

export default class DocsController extends Controller {
  async index(): Promise<Response> {
    return this.#renderIndex(DEFAULT_DOC_LOCALE)
  }

  async indexJa(): Promise<Response> {
    return this.#renderIndex('ja')
  }

  async show(): Promise<Response> {
    return this.#show(DEFAULT_DOC_LOCALE)
  }

  async showJa(): Promise<Response> {
    return this.#show('ja')
  }

  async #show(locale: DocLocale): Promise<Response> {
    const categoryParam = this.request.param('category') || undefined
    const slugParam = this.request.param('slug') || undefined

    const moved = this.#redirectFor(categoryParam, slugParam, locale)
    if (moved) {
      return this.redirect(moved, { status: 301 })
    }

    // /docs/guides/routing.md serves the raw Markdown source for LLM agents.
    if (slugParam?.endsWith('.md')) {
      return this.#serveMarkdown(categoryParam, slugParam, locale)
    }

    return this.#renderShow({ categoryParam, slugParam, locale })
  }

  /**
   * Where a slug the docs absorbed now lives (DOC_REDIRECTS). Runs before the
   * lookup so a retired page never depends on its file still being there, and
   * keeps the `.md` suffix so an agent's raw-markdown link survives the move.
   */
  #redirectFor(
    categoryParam: string | undefined,
    slugParam: string | undefined,
    locale: DocLocale,
  ): string | null {
    const category = normalizeDocCategory(categoryParam)
    if (!category || !slugParam) {
      return null
    }

    const markdown = slugParam.endsWith('.md')
    const slug = normalizeDocSlug(markdown ? slugParam.slice(0, -'.md'.length) : slugParam)
    const target = slug ? DOC_REDIRECTS[category][slug] : undefined
    if (!target) {
      return null
    }

    return `${this.#basePathForLocale(locale)}/${category}/${target}${markdown ? '.md' : ''}`
  }

  async #serveMarkdown(
    categoryParam: string | undefined,
    slugParam: string | undefined,
    locale: DocLocale,
  ): Promise<Response> {
    const markdown = await docsService.getRawMarkdown(categoryParam, slugParam, locale)

    if (!markdown) {
      return this.text('Not found', { status: 404 })
    }

    return this.text(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': DOCS_CACHE_CONTROL,
      },
    })
  }

  async #renderIndex(locale: DocLocale): Promise<Response> {
    const categories = await docsService.listDocs(locale)
    const locales = this.#localeLinks(locale)
    const basePath = this.#basePathForLocale(locale)

    return this.inertia(
      pages.Docs.Index,
      { categories, locale, locales, basePath },
      {
        title: this.#titleForLocale(locale),
        lang: locale,
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

    const title = doc ? pageTitle(doc.title) : this.#notFoundTitle(locale)
    const active = doc
      ? { category: doc.category, slug: doc.slug }
      : normalizedCategory && normalizedSlug
        ? { category: normalizedCategory, slug: normalizedSlug }
        : undefined
    const locales = this.#localeLinks(locale, { category: normalizedCategory, slug: normalizedSlug })
    const basePath = this.#basePathForLocale(locale)

    return this.inertia(
      pages.Docs.Show,
      { categories, doc, active, locale, locales, basePath },
      {
        title,
        status: doc ? 200 : 404,
        lang: locale,
      },
    )
  }

  #basePathForLocale(locale: DocLocale): string {
    return docsBasePath(locale)
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
    return pageTitle(locale === 'ja' ? 'ドキュメント' : 'Documentation')
  }

  #notFoundTitle(locale: DocLocale): string {
    if (locale === 'ja') return 'ドキュメントが見つかりません'
    return 'Document Not Found'
  }
}
