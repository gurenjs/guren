import { Head, Link } from '@inertiajs/react'
import { useEffect, useState } from 'react'
import { Footer } from '../../components/Footer.js'
import { Header } from '../../components/Header.js'
import { docsTheme, useDocsPageTheme } from './theme.js'

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

interface Props {
  categories: DocCategoryGroup[]
  doc: DocPage | null
  active?: { category: string; slug: string }
  locale: string
  locales?: LocaleLink[]
  basePath: string
}

type ActiveDoc = NonNullable<Props['active']>

interface NavLink {
  title: string
  href: string
  kind: 'prev' | 'next'
}

interface TocItem {
  id: string
  text: string
  level: number
}

function buildPrevNext(
  categories: DocCategoryGroup[],
  active: ActiveDoc | undefined,
  basePath: string,
): { prev?: NavLink; next?: NavLink } {
  if (!active) return {}

  const flat: Array<{ category: string; slug: string; title: string }> = []
  for (const group of categories) {
    for (const doc of group.docs) {
      flat.push({ category: group.category, slug: doc.slug, title: doc.title })
    }
  }

  const index = flat.findIndex((item) => item.category === active.category && item.slug === active.slug)
  if (index === -1) return {}

  const prevItem = flat[index - 1]
  const nextItem = flat[index + 1]

  return {
    prev: prevItem
      ? { kind: 'prev', title: prevItem.title, href: `${basePath}/${prevItem.category}/${prevItem.slug}` }
      : undefined,
    next: nextItem
      ? { kind: 'next', title: nextItem.title, href: `${basePath}/${nextItem.category}/${nextItem.slug}` }
      : undefined,
  }
}

function useTableOfContents(doc: DocPage | null) {
  const [items, setItems] = useState<TocItem[]>([])
  const [activeId, setActiveId] = useState<string>('')

  useEffect(() => {
    if (!doc) return

    const container = document.querySelector('.docs-content')
    if (!container) return

    const headings = container.querySelectorAll<HTMLElement>('h2, h3')
    const tocItems: TocItem[] = []

    headings.forEach((heading) => {
      if (!heading.id) {
        heading.id = heading.textContent?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') ?? ''
      }
      if (heading.id) {
        tocItems.push({
          id: heading.id,
          text: heading.textContent ?? '',
          level: heading.tagName === 'H2' ? 2 : 3,
        })
      }
    })

    setItems(tocItems)

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
            break
          }
        }
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    )

    headings.forEach((h) => {
      if (h.id) observer.observe(h)
    })

    return () => observer.disconnect()
  }, [doc])

  return { items, activeId }
}

export default function DocsShow({ categories, doc, active, locales = [], basePath }: Props) {
  useDocsPageTheme()

  const pageTitle = doc ? `${doc.title} – Documentation` : 'Document Not Found'
  const docLabel = doc?.category === 'tutorials' ? 'Tutorial' : 'Guide'
  const nav = buildPrevNext(categories, active, basePath)
  const toc = useTableOfContents(doc)

  // Copy button effect
  useEffect(() => {
    if (!doc) return

    const container = document.querySelector('.docs-content')
    if (!container) return

    container.querySelectorAll('.docs-copy-btn').forEach((btn) => btn.remove())

    const blocks = container.querySelectorAll<HTMLPreElement>('pre')
    const topLevelBlocks = Array.from(blocks).filter((pre) => !pre.closest('pre pre'))
    const cleanups: Array<() => void> = []

    topLevelBlocks.forEach((pre) => {
      pre.querySelectorAll('.docs-copy-btn').forEach((btn) => btn.remove())

      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'docs-copy-btn'
      button.textContent = 'Copy'

      const code = pre.querySelector('code')
      const getText = () => (code ? code.innerText : pre.innerText)

      const handleClick = async () => {
        try {
          await navigator.clipboard.writeText(getText())
          button.textContent = 'Copied!'
          setTimeout(() => { button.textContent = 'Copy' }, 1500)
        } catch (err) {
          console.error('Failed to copy code block', err)
          button.textContent = 'Error'
          setTimeout(() => { button.textContent = 'Copy' }, 1500)
        }
      }

      button.addEventListener('click', handleClick)
      pre.prepend(button)
      cleanups.push(() => {
        button.removeEventListener('click', handleClick)
        button.remove()
      })
    })

    return () => { cleanups.forEach((fn) => fn()) }
  }, [doc])

  return (
    <>
      <Head title={pageTitle} />
      <Header variant="docs" basePath={basePath} locales={locales} />

      <main className={`docs-layout ${toc.items.length > 0 ? 'docs-layout--toc' : ''}`}>
        {/* Sidebar */}
        <aside className="docs-sidebar">
          {categories.map((group) => (
            <section key={group.category} className="mb-8">
              <h2 className="mb-3 pl-2 text-xs font-bold uppercase tracking-widest text-docs-heading">
                {group.title}
              </h2>
              <nav className="flex flex-col gap-0.5">
                {group.docs.map((entry) => {
                  const isActive = active?.category === group.category && active?.slug === entry.slug
                  return (
                    <Link
                      key={`${group.category}-${entry.slug}`}
                      href={`${basePath}/${group.category}/${entry.slug}`}
                      className={`docs-nav-link ${isActive ? 'docs-nav-link--active' : ''}`}
                      style={{
                        padding: '0.4rem 0.6rem',
                        borderRadius: '6px',
                        textDecoration: 'none',
                        color: isActive ? docsTheme.accent.strong : docsTheme.text.secondary,
                        backgroundColor: isActive ? docsTheme.accent.tint : 'transparent',
                        fontWeight: isActive ? 600 : 400,
                        fontSize: '0.925rem',
                        borderLeft: isActive ? `2px solid ${docsTheme.accent.strong}` : '2px solid transparent',
                      }}
                    >
                      {entry.title}
                    </Link>
                  )
                })}
              </nav>
            </section>
          ))}
        </aside>

        {/* Article */}
        <article className="docs-article">
          {doc ? (
            <>
              <header className="mb-12">
                <div className="mb-4 flex items-center gap-3">
                  <span className="rounded bg-docs-accent-tint px-2 py-1 text-xs font-bold uppercase tracking-widest text-docs-accent">
                    {docLabel}
                  </span>
                  <span className="text-sm text-docs-text-muted">/</span>
                  <span className="text-sm font-medium text-docs-text-muted">{doc.category}</span>
                </div>
                <h1 className="mb-4 text-[2.75rem] font-extrabold leading-[1.1] tracking-tight text-docs-heading">
                  {doc.title}
                </h1>
                {doc.description && (
                  <p className="max-w-[720px] text-xl leading-relaxed text-docs-text-secondary">
                    {doc.description}
                  </p>
                )}
              </header>
              <div
                className="docs-content"
                dangerouslySetInnerHTML={{ __html: doc.html }}
              />
              {(nav.prev || nav.next) && (
                <nav
                  aria-label="Document pagination"
                  className="mt-16 grid gap-6 border-t border-docs-border pt-8"
                  style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
                >
                  {nav.prev ? (
                    <Link
                      href={nav.prev.href}
                      className="docs-pagination-link flex flex-col gap-1.5 rounded-xl border border-docs-border bg-docs-page p-5 no-underline"
                    >
                      <span className="text-sm font-semibold text-docs-text-muted">← Previous</span>
                      <span className="text-lg font-semibold text-docs-heading">{nav.prev.title}</span>
                    </Link>
                  ) : <div />}
                  {nav.next && (
                    <Link
                      href={nav.next.href}
                      className="docs-pagination-link flex flex-col gap-1.5 rounded-xl border border-docs-border bg-docs-page p-5 text-right no-underline"
                    >
                      <span className="text-sm font-semibold text-docs-text-muted">Next →</span>
                      <span className="text-lg font-semibold text-docs-heading">{nav.next.title}</span>
                    </Link>
                  )}
                </nav>
              )}
            </>
          ) : (
            <section className="mx-auto max-w-[600px] py-24 text-center">
              <div className="mb-4 text-6xl">404</div>
              <h1 className="mb-4 text-4xl font-extrabold text-docs-heading">Page not found</h1>
              <p className="mb-10 text-lg leading-relaxed text-docs-text-secondary">
                The page you are looking for doesn't exist or has been moved.
              </p>
              <Link
                href={basePath}
                className="inline-flex items-center gap-2 rounded-full bg-docs-accent px-6 py-3 font-semibold text-white no-underline transition hover:scale-105"
              >
                Back to Documentation
              </Link>
            </section>
          )}
        </article>

        {/* Table of Contents */}
        {toc.items.length > 0 && (
          <aside className="docs-toc">
            <p className="mb-3 text-xs font-bold uppercase tracking-widest text-docs-text-muted">
              On this page
            </p>
            <nav className="flex flex-col gap-1">
              {toc.items.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className={`block rounded px-2 py-1 text-[0.8rem] no-underline transition ${
                    item.level === 3 ? 'pl-4' : ''
                  } ${
                    toc.activeId === item.id
                      ? 'font-semibold text-docs-accent'
                      : 'text-docs-text-muted hover:text-docs-text'
                  }`}
                >
                  {item.text}
                </a>
              ))}
            </nav>
          </aside>
        )}
      </main>

      <Footer variant="docs" />
    </>
  )
}
