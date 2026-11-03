import { Link } from '@inertiajs/react'
import type { ComponentType, SVGProps } from 'react'

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
  locale: 'en' | 'ja'
  locales?: LocaleLink[]
  basePath: string
}
import { SITE_DESCRIPTION, pageTitle } from '../../../../config/site.js'
import { DocSearch } from '../../components/DocSearch.js'
import { Footer } from '../../components/Footer.js'
import { Header } from '../../components/Header.js'
import { Seo } from '../../components/Seo.js'
import { BookOpenIcon, ChevronRightIcon, LayersIcon, TerminalIcon } from '../../components/icons.js'
import { firstSentence } from '../../lib/first-sentence.js'

const HERO_COPY = {
  en: {
    eyebrow: 'Documentation',
    titleTop: 'Learn Guren,',
    titleAccent: 'end to end.',
    lead: 'Guides for every subsystem — routing, models, auth, queues — and two courses that build a working app: one by hand, one by directing a coding agent. Every page starts with code you can run.',
    empty: 'No documentation in this section yet.',
    startHere: 'Start here',
    pages: (count: number) => `${count} pages`,
  },
  ja: {
    eyebrow: 'ドキュメント',
    titleTop: 'Guren を、',
    titleAccent: '最初から最後まで。',
    lead: 'ルーティング、モデル、認証、キューまで全サブシステムのガイドと、動くアプリを作る 2 つのコース。1 つは自分で書き、もう 1 つはコーディングエージェントに任せます。どのページも実行できるコードから始まります。',
    empty: 'このセクションのドキュメントはまだありません。',
    startHere: 'ここから始める',
    pages: (count: number) => `${count} ページ`,
  },
} as const

interface EntryCopy {
  label: string
  title: string
  body: string
}

/** The three ways in, each the first page of its category. */
const ENTRY_COPY: Record<Props['locale'], Record<'guides' | 'tutorials' | 'agent-course', EntryCopy>> = {
  en: {
    guides: {
      label: 'Quickstart',
      title: 'Get started',
      body: 'A fresh app running in about five minutes on SQLite, then the full setup when you need it.',
    },
    tutorials: {
      label: 'Tutorial',
      title: 'Build a blog by hand',
      body: 'From an empty directory to a deployed blog with users, comments and uploads, one chapter at a time.',
    },
    'agent-course': {
      label: 'Agent course',
      title: 'Build with an agent',
      body: 'Review and approve each plan, then watch a coding agent build a meetup app one step at a time.',
    },
  },
  ja: {
    guides: {
      label: 'クイックスタート',
      title: 'はじめる',
      body: 'SQLite なら 5 分ほどで新しいアプリが動きます。本格的なセットアップは必要になってから進められます。',
    },
    tutorials: {
      label: 'チュートリアル',
      title: 'ブログを自分で作る',
      body: '空のディレクトリから、ユーザーやコメント、ファイルアップロードのあるブログをデプロイするまで、章ごとに進めます。',
    },
    'agent-course': {
      label: 'エージェント講座',
      title: 'エージェントと作る',
      body: '計画をレビューして承認すると、コーディングエージェントが勉強会の予約アプリを 1 ステップずつ作ります。',
    },
  },
}

const ENTRY_ICONS: Record<keyof (typeof ENTRY_COPY)['en'], ComponentType<SVGProps<SVGSVGElement>>> = {
  guides: TerminalIcon,
  tutorials: BookOpenIcon,
  'agent-course': LayersIcon,
}

const GETTING_STARTED_SLUG = 'getting-started'

function entryHref(group: DocCategoryGroup, basePath: string): string | undefined {
  const doc =
    group.category === 'guides'
      ? group.docs.find((candidate) => candidate.slug === GETTING_STARTED_SLUG)
      : group.docs[0]
  return doc ? `${basePath}/${group.category}/${doc.slug}` : undefined
}

export default function DocsIndex({ categories, locale, locales = [], basePath }: Props) {
  const copy = HERO_COPY[locale]
  const entries = categories.flatMap((group) => {
    const key = group.category as keyof (typeof ENTRY_COPY)['en']
    const href = entryHref(group, basePath)
    return key in ENTRY_COPY[locale] && href ? [{ key, href, ...ENTRY_COPY[locale][key] }] : []
  })

  return (
    <>
      <Seo
        title={pageTitle(locale === 'ja' ? 'ドキュメント' : 'Documentation')}
        description={SITE_DESCRIPTION[locale]}
        path={basePath}
        locale={locale}
        alternates={locales.map((link) => ({ hrefLang: link.code, href: link.href }))}
      />
      <Header variant="docs" basePath={basePath} locales={locales} />

      <main className="min-h-[calc(100vh-70px)] bg-docs-page text-docs-text" style={{ fontFamily: 'system-ui, sans-serif' }}>
        <div className="mx-auto max-w-[1200px] px-6 pb-24 pt-14">
          <header className="max-w-[760px]">
            {/* the ember tick — this screen has no current-place nav, so the
                page title block carries the one tick */}
            <p className="docs-kicker mb-4 flex items-center gap-2.5 text-sm text-docs-accent">
              <span className="docs-tick" aria-hidden="true" />
              {copy.eyebrow}
            </p>
            <h1 className="mb-5 text-[2.5rem] font-extrabold leading-[1.1] tracking-tight text-docs-heading sm:text-[3rem]">
              {copy.titleTop} <br />
              <span className="bg-gradient-to-br from-[#db1b1b] to-[#7f1d1d] bg-clip-text text-transparent">
                {copy.titleAccent}
              </span>
            </h1>
            <p className="max-w-[640px] text-lg leading-relaxed text-docs-text-secondary">{copy.lead}</p>
            <DocSearch locale={locale} className="mt-7 max-w-[420px]" />
          </header>

          {entries.length > 0 && (
            <section aria-labelledby="docs-start-here" className="mt-12">
              <h2 id="docs-start-here" className="docs-kicker text-xs text-docs-text-secondary">
                {copy.startHere}
              </h2>
              <ul className="mt-4 grid gap-px overflow-hidden rounded-xl border border-docs-border bg-docs-border md:grid-cols-3">
                {entries.map(({ key, href, label, title, body }) => {
                  const Icon = ENTRY_ICONS[key]
                  return (
                    <li key={key} className="bg-docs-panel">
                      <Link
                        href={href}
                        className="docs-entry group flex h-full flex-col p-6 no-underline"
                      >
                        <span className="flex items-center gap-2.5">
                          <Icon aria-hidden className="size-5 text-docs-accent" />
                          <span className="docs-kicker text-[0.7rem] text-docs-text-secondary">{label}</span>
                        </span>
                        <span className="mt-4 text-lg font-bold text-docs-heading">{title}</span>
                        <span className="mt-1.5 flex-1 text-[0.95rem] leading-relaxed text-docs-text-secondary">{body}</span>
                        <ChevronRightIcon
                          aria-hidden
                          className="mt-4 size-4 text-docs-text-secondary transition group-hover:translate-x-0.5 group-hover:text-docs-accent"
                        />
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {categories.map((group) => (
            <section key={group.category} aria-labelledby={`docs-${group.category}`} className="mt-16">
              <div className="flex items-baseline gap-4 border-b border-docs-border pb-3">
                <h2 id={`docs-${group.category}`} className="text-2xl font-bold tracking-tight text-docs-heading">
                  {group.title}
                </h2>
                <span className="docs-mono text-xs text-docs-text-secondary">{copy.pages(group.docs.length)}</span>
              </div>

              {group.sections.length ? (
                <div className="mt-8 gap-x-10 sm:columns-2 lg:columns-3">
                  {group.sections.map((section) => (
                    <div key={`${group.category}-${section.title}`} className="mb-10 break-inside-avoid">
                      <h3 className="docs-kicker mb-2 text-[0.7rem] text-docs-text-secondary">{section.title}</h3>
                      <ul>
                        {section.docs.map((doc) => (
                          <li key={`${group.category}-${doc.slug}`}>
                            <Link
                              href={`${basePath}/${group.category}/${doc.slug}`}
                              className="docs-index-link -mx-2 block rounded-md px-2 py-1.5 no-underline"
                            >
                              <span className="block font-semibold text-docs-heading">{doc.title}</span>
                              {doc.description && (
                                <span className="mt-0.5 line-clamp-2 block text-sm leading-snug text-docs-text-secondary">
                                  {firstSentence(doc.description)}
                                </span>
                              )}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-6 italic text-docs-text-secondary">{copy.empty}</p>
              )}
            </section>
          ))}
        </div>
      </main>

      <Footer variant="docs" />
    </>
  )
}
