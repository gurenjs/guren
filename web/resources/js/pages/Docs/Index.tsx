import { Link } from '@inertiajs/react'

type DocSummary = {
  slug: string
  title: string
  description?: string
}

type DocSection = {
  title: string
  docs: DocSummary[]
}

type DocCategoryGroup = {
  category: string
  title: string
  docs: DocSummary[]
  sections: DocSection[]
}

type LocaleLink = {
  code: string
  label: string
  href: string
  active?: boolean
}

interface Props {
  categories: DocCategoryGroup[]
  locale: string
  locales?: LocaleLink[]
  basePath: string
}
import { SITE_DESCRIPTION, SITE_NAME } from '../../../../config/site.js'
import { Footer } from '../../components/Footer.js'
import { Header } from '../../components/Header.js'
import { Seo } from '../../components/Seo.js'
import { BookOpenIcon, TerminalIcon } from '../../components/icons.js'
import { useDocsPageTheme } from './theme.js'

const HERO_COPY = {
  en: {
    eyebrow: 'Documentation',
    titleTop: 'Learn Guren,',
    titleAccent: 'end to end.',
    lead: 'Guides for every subsystem — routing, models, auth, queues — and tutorials that build a working app. Every page starts with code you can run.',
    empty: 'No documentation in this section yet.',
  },
  ja: {
    eyebrow: 'ドキュメント',
    titleTop: 'Guren を、',
    titleAccent: '最初から最後まで。',
    lead: 'ルーティング、モデル、認証、キューまで全サブシステムのガイドと、動くアプリを作るチュートリアル。どのページも実行できるコードから始まります。',
    empty: 'このセクションのドキュメントはまだありません。',
  },
} as const

export default function DocsIndex({ categories, locale, locales = [], basePath }: Props) {
  useDocsPageTheme()

  const docLocale: 'en' | 'ja' = locale === 'ja' ? 'ja' : 'en'
  const copy = HERO_COPY[docLocale]

  return (
    <>
      <Seo
        title={docLocale === 'ja' ? `ドキュメント — ${SITE_NAME}` : `Documentation — ${SITE_NAME}`}
        description={SITE_DESCRIPTION[docLocale]}
        path={basePath}
        locale={docLocale}
        alternates={locales.map((link) => ({ hrefLang: link.code, href: link.href }))}
      />
      <Header variant="docs" basePath={basePath} locales={locales} />

      <main className="min-h-[calc(100vh-70px)] bg-docs-page text-docs-text" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <div className="mx-auto max-w-[1200px] px-6 pt-16 pb-24">
          <header className="mb-20 max-w-[800px]">
            <p className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-docs-accent">
              <span className="inline-block h-px w-5 bg-docs-accent" />
              {copy.eyebrow}
            </p>
            <h1 className="mb-6 text-[3.5rem] font-extrabold leading-[1.1] tracking-tight text-docs-heading">
              {copy.titleTop} <br />
              <span className="bg-gradient-to-br from-[#db1b1b] to-[#7f1d1d] bg-clip-text text-transparent">
                {copy.titleAccent}
              </span>
            </h1>
            <p className="max-w-[640px] text-xl leading-relaxed text-docs-text-secondary">
              {copy.lead}
            </p>
          </header>

          <div className="grid gap-16">
            {categories.map((group) => (
              <section key={group.category}>
                <div className="mb-8 flex items-baseline gap-4">
                  <div className="flex items-center gap-2">
                    {group.category === 'guides' ? (
                      <BookOpenIcon className="size-5 text-docs-accent" />
                    ) : (
                      <TerminalIcon className="size-5 text-docs-accent" />
                    )}
                    <h2 className="text-2xl font-bold tracking-tight text-docs-heading">
                      {group.title}
                    </h2>
                  </div>
                  <div className="h-px flex-1 bg-docs-border opacity-60" />
                </div>

                {group.sections.length ? (
                  <div className="grid gap-12">
                    {group.sections.map((section) => (
                      <div key={`${group.category}-${section.title}`}>
                        <h3 className="mb-5 text-sm font-bold uppercase tracking-widest text-docs-text-muted">
                          {section.title}
                        </h3>
                        <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                          {section.docs.map((doc) => (
                            <Link
                              key={`${group.category}-${doc.slug}`}
                              href={`${basePath}/${group.category}/${doc.slug}`}
                              className="no-underline"
                            >
                              <article className="docs-card flex h-full cursor-pointer flex-col rounded-xl border border-docs-border bg-docs-panel p-7">
                                <h3 className="mb-3 text-[1.15rem] font-semibold text-docs-heading">
                                  {doc.title}
                                </h3>
                                {doc.description && (
                                  <p className="flex-1 text-[0.95rem] leading-relaxed text-docs-text-secondary">
                                    {doc.description}
                                  </p>
                                )}
                              </article>
                            </Link>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="italic text-docs-text-muted">{copy.empty}</p>
                )}
              </section>
            ))}
          </div>
        </div>
      </main>

      <Footer variant="docs" />
    </>
  )
}
