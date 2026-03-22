import type { PageProps } from '@guren/inertia-client/contracts'
import { pages as generatedPages } from '../../../.guren/pages.gen.ts'

type DocSummary = {
  slug: string
  title: string
  description?: string
}

type DocCategoryGroup = {
  category: string
  title: string
  docs: DocSummary[]
}

type DocPage = DocSummary & {
  category: string
  html: string
}

type LocaleLink = {
  code: string
  label: string
  href: string
  active?: boolean
}

export const webPages = {
  home: generatedPages.Home.props<{
    message: string
  }>(),
  docs: {
    index: generatedPages.Docs.Index.props<{
      categories: DocCategoryGroup[]
      locale: string
      locales?: LocaleLink[]
      basePath: string
    }>(),
    show: generatedPages.Docs.Show.props<{
      categories: DocCategoryGroup[]
      doc: DocPage | null
      active?: {
        category: string
        slug: string
      }
      locale: string
      locales?: LocaleLink[]
      basePath: string
    }>(),
  },
} as const

export type HomePageProps = PageProps<typeof webPages.home>
export type DocsIndexPageProps = PageProps<typeof webPages.docs.index>
export type DocsShowPageProps = PageProps<typeof webPages.docs.show>
