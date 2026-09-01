import { Head, Link, router } from '@inertiajs/react'
import { useEffect, useMemo, useState } from 'react'
import { SITE_DESCRIPTION, pageTitle } from '../../../../config/site.js'
import { DocSearch } from '../../components/DocSearch.js'
import { Footer } from '../../components/Footer.js'
import { Header } from '../../components/Header.js'
import { Seo } from '../../components/Seo.js'
import { ChevronRightIcon } from '../../components/icons.js'
import { breadcrumbJsonLd, techArticleJsonLd } from '../../lib/structured-data.js'
import { useColorMode } from './theme.js'

// Staged out of node_modules by scripts/lib/stage-mermaid.ts, and shared with
// the prerendered docs-viewer snapshot, whose shell fixes this path.
const MERMAID_SCRIPT_SRC = '/_guren/docs/assets/mermaid.js'

// Mirrors --font-family-display in resources/css/app.css.
const DIAGRAM_FONT_FAMILY =
  "'Inter', 'Inter var', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

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
  locale: 'en' | 'ja'
  locales?: LocaleLink[]
  basePath: string
}

type ActiveDoc = NonNullable<Props['active']>

interface NavLink {
  title: string
  href: string
  kind: 'prev' | 'next'
}

interface MermaidApi {
  initialize(config: Record<string, unknown>): void
  run(options: { nodes: ArrayLike<HTMLElement> }): Promise<void>
}

declare global {
  interface Window {
    mermaid?: MermaidApi
  }
}

let mermaidLoader: Promise<MermaidApi> | null = null

/**
 * Load mermaid as a plain script rather than `import('mermaid')`.
 *
 * Bundling it is not an option here: the library cannot fit the repo's
 * 600 kB per-asset budget in any split (its cytoscape dependency alone is
 * ~870 kB), and the Vite plugin's catch-all `vendor` chunk collapses the
 * whole tree into one 3.2 MB file. Staged as a static asset instead, by
 * scripts/copy-docs-images.ts, and fetched only by the pages that have a
 * diagram — the same shape the framework's own `/_guren/docs` viewer uses.
 */
function loadMermaid(): Promise<MermaidApi> {
  if (window.mermaid) return Promise.resolve(window.mermaid)
  mermaidLoader ??= new Promise<MermaidApi>((resolvePromise, rejectPromise) => {
    const script = document.createElement('script')
    script.src = MERMAID_SCRIPT_SRC
    // Neither failure may be cached as the answer: the next diagram page
    // should get a fresh attempt rather than reusing a rejected promise.
    const fail = (message: string) => {
      mermaidLoader = null
      rejectPromise(new Error(message))
    }
    script.onload = () => {
      if (window.mermaid) {
        resolvePromise(window.mermaid)
      } else {
        fail('mermaid loaded without defining window.mermaid')
      }
    }
    script.onerror = () => fail(`Failed to load ${MERMAID_SCRIPT_SRC}`)
    document.head.append(script)
  })
  return mermaidLoader
}

/**
 * A hash is whatever is in the address bar, not necessarily something this
 * page wrote: `#%` makes decodeURIComponent throw, and an exception here
 * would take the whole effect — and with it the router subscription — down.
 */
function decodeFragment(hash: string): string {
  try {
    return decodeURIComponent(hash)
  } catch {
    return hash
  }
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
    if (!doc) {
      setItems([])
      setActiveId('')
      return
    }

    const container = document.querySelector('.docs-content')
    if (!container) return

    const headings = container.querySelectorAll<HTMLElement>('h2, h3')
    const tocItems: TocItem[] = []

    headings.forEach((heading) => {
      // The server slugger ids every heading; one without an id would only
      // mean a non-markdown heading, which the TOC has no anchor for anyway.
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

export default function DocsShow({ categories, doc, active, locale, locales = [], basePath }: Props) {
  const docLabel = doc?.category === 'tutorials' ? 'Tutorial' : 'Guide'
  const docPath = doc ? `${basePath}/${doc.category}/${doc.slug}` : basePath
  const nav = buildPrevNext(categories, active, basePath)
  const toc = useTableOfContents(doc)
  const { isDark } = useColorMode()
  // Load-bearing memo, not an optimisation. React 19 re-applies
  // dangerouslySetInnerHTML on the *identity* of the `{ __html }` object and
  // never compares the string (setProp in react-dom assigns innerHTML
  // unconditionally; the `lastHtml !== nextHtml` guard React 18 had is gone).
  // Written inline, the object is fresh on every render, so any unrelated
  // setState -- the TOC filling in, a theme toggle, the sidebar opening --
  // silently rebuilt this subtree and discarded everything the effects below
  // had put into it: the copy buttons, the rendered diagrams, and the heading
  // nodes the scroll-spy observer was watching.
  const docHtml = useMemo(() => ({ __html: doc?.html ?? '' }), [doc?.html])
  const [sidebarOpen, setSidebarOpen] = useState(false)

  useEffect(() => {
    setSidebarOpen(false)
  }, [active?.category, active?.slug])

  // A browser scrolls to the fragment on a full page load; Inertia does not
  // after a client-side visit, so a search result deep-linking to a heading
  // would land at the top of the page instead. Keyed on the router event
  // rather than on the doc, because two results in the same document differ
  // only by their fragment.
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined

    const scrollToFragment = () => {
      const id = decodeFragment(window.location.hash.slice(1))
      if (!id) return

      // Inertia announces the navigation before React has necessarily
      // committed the new document, so the heading may not exist yet. Retried
      // on the macrotask queue rather than on an animation frame: a tab that
      // is not visible never runs one, and a docs link opened in a background
      // tab should still be at its heading when the reader gets there.
      let attempts = 0
      const attempt = () => {
        const target = document.getElementById(id)
        if (target) {
          target.scrollIntoView({ block: 'start' })
          return
        }
        if (attempts++ < 10) {
          pending = setTimeout(attempt, 16)
        }
      }
      attempt()
    }

    scrollToFragment()
    const stop = router.on('navigate', scrollToFragment)
    return () => {
      clearTimeout(pending)
      stop()
    }
  }, [])

  // Mermaid diagrams: the build-time renderer leaves ```mermaid fences as
  // <pre class="mermaid"> (shiki has no grammar for them), and the library
  // is loaded here — lazily, client-only, and only on pages that have one.
  // The bail-out below is what keeps the request off every other docs page.
  useEffect(() => {
    if (!doc) return

    const container = document.querySelector('.docs-content')
    if (!container) return

    if (!container.querySelector('pre.mermaid')) return

    let cancelled = false

    void (async () => {
      let mermaid: MermaidApi
      try {
        mermaid = await loadMermaid()
      } catch (error) {
        console.error(error)
        return
      }
      if (cancelled) return

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: isDark ? 'dark' : 'default',
        // Must agree with `.docs-content pre.mermaid` in app.css: mermaid
        // sizes each node box by measuring its label in this font.
        fontFamily: DIAGRAM_FONT_FAMILY,
      })

      // Queried here, not above: hydration can replace the rendered-markdown
      // subtree between the effect firing and the script arriving, which
      // would leave us writing into detached nodes.
      const live = [...container.querySelectorAll<HTMLPreElement>('pre.mermaid')]

      for (const pre of live) {
        // run() reads each element's own text and replaces it in place, so
        // the source is stashed on first pass and restored here — a theme
        // toggle re-renders from the fence body rather than from an <svg>.
        const source = pre.dataset.mermaidSource ?? pre.textContent ?? ''
        pre.dataset.mermaidSource = source
        pre.textContent = source
        pre.removeAttribute('data-processed')
      }

      try {
        // Letting mermaid own the DOM write keeps diagram text from ever
        // being reinterpreted as markup by this component.
        await mermaid.run({ nodes: live })
      } catch (error) {
        // run() reports one malformed fence by rejecting *after* processing
        // the whole collection, so the diagrams it did render are marked
        // below either way — otherwise one bad fence would leave every good
        // one styled as a code block.
        console.error('Failed to render some mermaid diagrams', error)
      }
      if (cancelled) return

      for (const pre of live) {
        if (pre.querySelector('svg')) pre.dataset.mermaidRendered = 'true'
      }
    })()

    return () => {
      cancelled = true
    }
  }, [doc?.html, isDark])

  // Copy button effect
  useEffect(() => {
    if (!doc) return

    const container = document.querySelector('.docs-content')
    if (!container) return

    container.querySelectorAll('.docs-copy-btn').forEach((btn) => btn.remove())

    const blocks = container.querySelectorAll<HTMLPreElement>('pre')
    // `pre.mermaid` holds diagram source that becomes an <svg> below — there
    // is nothing there a reader would want on their clipboard.
    const topLevelBlocks = Array.from(blocks).filter(
      (pre) => !pre.closest('pre pre') && !pre.classList.contains('mermaid'),
    )
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
      {doc ? (
        <Seo
          title={pageTitle(doc.title)}
          description={doc.description ?? SITE_DESCRIPTION[locale]}
          path={docPath}
          locale={locale}
          alternates={locales.map((link) => ({ hrefLang: link.code, href: link.href }))}
          ogType="article"
          markdownPath={`${docPath}.md`}
          jsonLd={[
            techArticleJsonLd({
              title: doc.title,
              description: doc.description,
              path: docPath,
              locale,
            }),
            breadcrumbJsonLd([
              { name: locale === 'ja' ? 'ドキュメント' : 'Documentation', path: basePath },
              { name: doc.title, path: docPath },
            ]),
          ]}
        />
      ) : (
        <Head title={pageTitle('Page not found')} />
      )}
      <Header variant="docs" basePath={basePath} locales={locales} />

      <main className={`docs-layout ${toc.items.length > 0 ? 'docs-layout--toc' : ''}`}>
        {/* Sidebar */}
        <aside className="docs-sidebar">
          <DocSearch locale={locale} className="mb-6" />
          <button
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-expanded={sidebarOpen}
            className="flex w-full items-center justify-between gap-2 rounded-lg border border-docs-border bg-docs-panel px-4 py-3 text-left text-sm font-semibold text-docs-text lg:hidden"
          >
            <span className="truncate">{doc?.title ?? (locale === 'ja' ? 'ドキュメント' : 'Documentation')}</span>
            <ChevronRightIcon
              className={`size-4 shrink-0 text-docs-text-muted transition-transform ${sidebarOpen ? 'rotate-90' : ''}`}
            />
          </button>
          <div className={`${sidebarOpen ? 'mt-4 block' : 'hidden'} lg:block`}>
            {categories.map((group) => (
              <section key={group.category} className="mb-8">
                <h2 className="docs-kicker mb-4 pl-2 text-xs text-docs-heading">
                  {group.title}
                </h2>
                {group.sections.map((section) => (
                  <div key={`${group.category}-${section.title}`} className="mb-5">
                    <h3 className="docs-kicker mb-2 pl-2 text-[0.7rem] text-docs-text-secondary">
                      {section.title}
                    </h3>
                    <nav className="flex flex-col gap-0.5">
                      {section.docs.map((entry) => {
                        const isActive = active?.category === group.category && active?.slug === entry.slug
                        return (
                          <Link
                            key={`${group.category}-${entry.slug}`}
                            href={`${basePath}/${group.category}/${entry.slug}`}
                            className={`docs-nav-link ${isActive ? 'docs-nav-link--active' : ''}`}
                          >
                            {entry.title}
                          </Link>
                        )
                      })}
                    </nav>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </aside>

        {/* Article */}
        <article className="docs-article">
          {doc ? (
            <>
              <header className="mb-12">
                <div className="mb-4 flex items-center gap-3">
                  <span className="docs-kicker rounded-full bg-docs-accent-tint px-2.5 py-1 text-xs text-docs-accent">
                    {docLabel}
                  </span>
                  <span className="text-sm text-docs-text-muted">/</span>
                  <span className="docs-mono text-sm text-docs-text-secondary">{doc.category}</span>
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
                dangerouslySetInnerHTML={docHtml}
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
              <Link href={basePath} className="docs-btn-primary px-6 py-3">
                Back to Documentation
              </Link>
            </section>
          )}
        </article>

        {/* Table of Contents */}
        {toc.items.length > 0 && (
          <aside className="docs-toc">
            <p className="docs-kicker mb-3 text-xs text-docs-text-secondary">
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
