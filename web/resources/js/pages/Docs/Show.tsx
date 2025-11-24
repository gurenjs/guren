import { Head, Link } from '@inertiajs/react'
import { useEffect } from 'react'
import { docsTheme, useDocsPageTheme } from './theme.js'

interface DocSummary {
  slug: string
  title: string
  description?: string
}

interface DocCategoryGroup {
  category: string
  title: string
  docs: DocSummary[]
}

interface DocPage extends DocSummary {
  category: string
  html: string
}

interface ActiveDoc {
  category: string
  slug: string
}

interface DocsShowProps {
  categories: DocCategoryGroup[]
  doc: DocPage | null
  active?: ActiveDoc
  locale: string
  locales?: LocaleLink[]
  basePath: string
}

interface LocaleLink {
  code: string
  label: string
  href: string
  active?: boolean
}

interface NavLink {
  title: string
  href: string
  kind: 'prev' | 'next'
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
      ? {
        kind: 'prev',
        title: prevItem.title,
        href: `${basePath}/${prevItem.category}/${prevItem.slug}`,
      }
      : undefined,
    next: nextItem
      ? {
        kind: 'next',
        title: nextItem.title,
        href: `${basePath}/${nextItem.category}/${nextItem.slug}`,
      }
      : undefined,
  }
}

const docsContentStyles = `
  .docs-layout {
    font-family: ${docsTheme.fontFamily};
    margin: 0 auto;
    max-width: 1280px;
    padding: 2rem 1.5rem 4rem;
    display: grid;
    gap: 3rem;
    grid-template-columns: 260px minmax(0, 1fr);
    background-color: ${docsTheme.surfaces.page};
    color: ${docsTheme.text.primary};
  }
  .docs-sidebar {
    position: sticky;
    top: 5.5rem;
    align-self: start;
    max-height: calc(100vh - 6rem);
    overflow-y: auto;
    padding-right: 1rem;
  }
  .docs-sidebar::-webkit-scrollbar {
    width: 4px;
  }
  .docs-sidebar::-webkit-scrollbar-track {
    background: transparent;
  }
  .docs-sidebar::-webkit-scrollbar-thumb {
    background: ${docsTheme.border.soft};
    border-radius: 4px;
  }
  .docs-article {
    min-width: 0;
    max-width: 860px;
    padding-bottom: 4rem;
  }
  @media (max-width: 1024px) {
    .docs-layout {
      grid-template-columns: 1fr;
      padding: 2rem 1.25rem 3rem;
      gap: 2rem;
    }
    .docs-sidebar {
      position: static;
      max-height: none;
      padding-right: 0;
      border-bottom: 1px solid ${docsTheme.border.soft};
      padding-bottom: 2rem;
      margin-bottom: 1rem;
    }
  }
  .docs-content {
    min-width: 0;
    width: 100%;
    overflow-wrap: anywhere;
    word-break: break-word;
    font-size: 1.05rem;
    line-height: 1.75;
  }
  .docs-content ul,
  .docs-content ol {
    padding-left: 1.25em;
    margin: 1rem 0 1.5rem;
    display: grid;
    gap: 0.5rem;
  }
  .docs-content li {
    line-height: 1.7;
    padding-left: 0.25rem;
  }
  .docs-content ul {
    list-style: disc;
  }
  .docs-content ol {
    list-style: decimal;
  }
  .docs-content ul li::marker {
    color: ${docsTheme.accent.strong};
  }
  .docs-content > * {
    max-width: 100%;
  }
  .docs-content h1,
  .docs-content h2,
  .docs-content h3,
  .docs-content h4 {
    color: ${docsTheme.text.heading};
    font-weight: 700;
    line-height: 1.3;
    margin: 2.5rem 0 1rem;
    letter-spacing: -0.01em;
  }
  .docs-content h1 { font-size: 2.25rem; letter-spacing: -0.02em; }
  .docs-content h2 { 
    font-size: 1.75rem; 
    border-bottom: 1px solid ${docsTheme.border.soft}; 
    padding-bottom: 0.5rem; 
    margin-top: 3rem;
  }
  .docs-content h3 { font-size: 1.4rem; margin-top: 2rem; }
  .docs-content h4 { font-size: 1.15rem; }
  /* Hide the first document title; the page header already renders the title. */
  .docs-content > h1:first-of-type { display: none; }
  /* Hide the first paragraph as it is used as the description in the page header */
  .docs-content > h1:first-of-type + p { display: none; }
  .docs-content pre,
  .docs-content .shiki {
    max-width: 100%;
    width: 100%;
    box-sizing: border-box;
    margin: 1rem 0;
  }
  .docs-content pre {
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    position: relative;
    padding-top: 0.75rem;
  }
  .docs-content pre code {
    white-space: inherit;
  }
  .docs-content a {
    color: ${docsTheme.accent.strong};
    text-decoration: none;
    font-weight: 600;
    border-bottom: 1px solid transparent;
    transition: border-color 0.2s;
  }
  .docs-content a:hover {
    border-bottom-color: ${docsTheme.accent.strong};
  }
  .shiki {
    border-radius: 0.75rem;
    border: 1px solid ${docsTheme.border.soft};
    padding: 1rem 1.25rem;
    overflow-x: auto;
    background: ${docsTheme.surfaces.raised};
    font-size: 0.9rem;
    line-height: 1.5;
  }
  .shiki code {
    font-family: "JetBrains Mono", "SFMono-Regular", ui-monospace, "SFMono", monospace;
  }
  .docs-content :not(pre) > code {
    background: ${docsTheme.accent.tint};
    border-radius: 0.375rem;
    padding: 0.125rem 0.375rem;
    font-family: "JetBrains Mono", "SFMono-Regular", ui-monospace, "SFMono", monospace;
    font-size: 0.875em;
    color: ${docsTheme.accent.strong};
    font-weight: 500;
  }
  .docs-alert {
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    border-left: 4px solid;
    background: ${docsTheme.surfaces.raised};
    margin: 1.25rem 0;
  }
  .docs-alert__label {
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .docs-alert__body {
    font-size: 0.95rem;
  }
  .docs-alert__body > :first-child { margin-top: 0; }
  .docs-alert__body > :last-child { margin-bottom: 0; }
  
  .docs-alert--note { border-color: #3b82f6; background: #eff6ff; }
  .docs-alert--note .docs-alert__label { color: #1d4ed8; }
  
  .docs-alert--tip { border-color: #10b981; background: #ecfdf5; }
  .docs-alert--tip .docs-alert__label { color: #047857; }
  
  .docs-alert--important { border-color: #f59e0b; background: #fffbeb; }
  .docs-alert--important .docs-alert__label { color: #b45309; }
  
  .docs-alert--warning { border-color: #f97316; background: #fff7ed; }
  .docs-alert--warning .docs-alert__label { color: #c2410c; }
  
  .docs-alert--caution { border-color: #ef4444; background: #fef2f2; }
  .docs-alert--caution .docs-alert__label { color: #b91c1c; }

  .docs-copy-btn {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    border: 1px solid ${docsTheme.border.soft};
    background: ${docsTheme.surfaces.page};
    color: ${docsTheme.text.secondary};
    border-radius: 0.375rem;
    padding: 0.2rem 0.4rem;
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    opacity: 0;
    z-index: 10;
  }
  pre:hover .docs-copy-btn {
    opacity: 1;
  }
  .docs-copy-btn:hover {
    background: ${docsTheme.surfaces.raised};
    color: ${docsTheme.text.primary};
    border-color: ${docsTheme.border.strong};
  }
  .docs-content img,
  .docs-content video {
    max-width: 100%;
    height: auto;
    border-radius: 0.75rem;
    border: 1px solid ${docsTheme.border.soft};
    box-shadow: ${docsTheme.shadow.card};
  }
  .docs-content table {
    width: 100%;
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
    margin: 1.5rem 0;
    font-size: 0.95rem;
  }
  .docs-content table thead tr {
    border-bottom: 2px solid ${docsTheme.border.soft};
  }
  .docs-content table th {
    font-weight: 600;
    text-align: left;
    padding: 0.75rem 1rem;
    color: ${docsTheme.text.heading};
  }
  .docs-content table td {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid ${docsTheme.border.soft};
    color: ${docsTheme.text.primary};
  }
`

export default function DocsShow({ categories, doc, active, locales = [], basePath }: DocsShowProps) {
  useDocsPageTheme()

  const pageTitle = doc ? `${doc.title} – Documentation` : 'Document Not Found'
  const docLabel = doc?.category === 'tutorials' ? 'Tutorial' : 'Guide'
  const nav = buildPrevNext(categories, active, basePath)

  useEffect(() => {
    if (!doc) return

    const container = document.querySelector('.docs-content')
    if (!container) return

    // Clean up any existing buttons before re-adding (handles strict mode/double renders).
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
          setTimeout(() => {
            button.textContent = 'Copy'
          }, 1500)
        } catch (err) {
          console.error('Failed to copy code block', err)
          button.textContent = 'Error'
          setTimeout(() => {
            button.textContent = 'Copy'
          }, 1500)
        }
      }

      button.addEventListener('click', handleClick)
      pre.prepend(button)
      cleanups.push(() => {
        button.removeEventListener('click', handleClick)
        button.remove()
      })
    })

    return () => {
      cleanups.forEach((fn) => fn())
    }
  }, [doc])

  return (
    <>
      <Head title={pageTitle} />
      <style dangerouslySetInnerHTML={{ __html: docsContentStyles }} />
      <header
        style={{
          backgroundColor: docsTheme.surfaces.page,
          borderBottom: `1px solid ${docsTheme.border.soft}`,
          padding: '1rem 1.5rem',
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}
      >
        <div
          style={{
            maxWidth: '1280px',
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
          }}
        >
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', textDecoration: 'none', color: 'inherit' }}>
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #db1b1b, #991b1b)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'white',
              fontWeight: 'bold',
              fontSize: '18px'
            }}>
              G
            </div>
            <span style={{ fontSize: '1.1rem', fontWeight: 700, color: docsTheme.text.heading, letterSpacing: '-0.02em' }}>Guren Docs</span>
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
            <nav style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <Link href={basePath} style={{ color: docsTheme.text.primary, textDecoration: 'none', fontWeight: 500, fontSize: '0.95rem' }}>
                Guides
              </Link>
              <Link href={`${basePath}/tutorials/overview`} style={{ color: docsTheme.text.primary, textDecoration: 'none', fontWeight: 500, fontSize: '0.95rem' }}>
                Tutorials
              </Link>
              <Link href="https://github.com/gurenjs/guren" style={{ color: docsTheme.text.muted, textDecoration: 'none', fontWeight: 500, fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                GitHub <span style={{ fontSize: '0.8em' }}>↗</span>
              </Link>
            </nav>
            {locales.length > 1 ? (
              <div style={{ display: 'flex', gap: '0.25rem', alignItems: 'center', flexWrap: 'wrap', paddingLeft: '1rem', borderLeft: `1px solid ${docsTheme.border.soft}` }}>
                {locales.map((locale) => (
                  <Link
                    key={locale.code}
                    href={locale.href}
                    style={{
                      padding: '0.25rem 0.6rem',
                      borderRadius: '6px',
                      textDecoration: 'none',
                      color: locale.active ? docsTheme.accent.strong : docsTheme.text.muted,
                      backgroundColor: locale.active ? docsTheme.accent.tint : 'transparent',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    {locale.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>
      <main className="docs-layout">
        <aside className="docs-sidebar">
          {categories.map((group) => (
            <section key={group.category} style={{ marginBottom: '2rem' }}>
              <h2
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: docsTheme.text.heading,
                  marginBottom: '0.75rem',
                  paddingLeft: '0.5rem',
                }}
              >
                {group.title}
              </h2>
              <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                {group.docs.map((entry) => {
                  const isActive = active?.category === group.category && active?.slug === entry.slug
                  const className = isActive ? 'docs-nav-link docs-nav-link--active' : 'docs-nav-link'
                  return (
                    <Link
                      key={`${group.category}-${entry.slug}`}
                      href={`${basePath}/${group.category}/${entry.slug}`}
                      className={className}
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
        <article className="docs-article">
          {doc ? (
            <>
              <header style={{ marginBottom: '3rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                  <span
                    style={{
                      color: docsTheme.accent.strong,
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      backgroundColor: docsTheme.accent.tint,
                      padding: '0.25rem 0.5rem',
                      borderRadius: '4px',
                    }}
                  >
                    {docLabel}
                  </span>
                  <span style={{ color: docsTheme.text.muted, fontSize: '0.875rem' }}>/</span>
                  <span style={{ color: docsTheme.text.muted, fontSize: '0.875rem', fontWeight: 500 }}>{doc.category}</span>
                </div>
                <h1
                  style={{
                    fontSize: '2.75rem',
                    fontWeight: 800,
                    margin: '0 0 1rem',
                    color: docsTheme.text.heading,
                    lineHeight: 1.1,
                    letterSpacing: '-0.02em',
                  }}
                >
                  {doc.title}
                </h1>
                {doc.description && (
                  <p style={{ fontSize: '1.25rem', color: docsTheme.text.secondary, lineHeight: 1.6, maxWidth: '720px' }}>
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
                  style={{
                    marginTop: '4rem',
                    paddingTop: '2rem',
                    borderTop: `1px solid ${docsTheme.border.soft}`,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                    gap: '1.5rem',
                  }}
                >
                  {nav.prev ? (
                    <Link
                      href={nav.prev.href}
                      style={{
                        padding: '1.25rem',
                        borderRadius: '0.75rem',
                        border: `1px solid ${docsTheme.border.soft}`,
                        background: docsTheme.surfaces.page,
                        textDecoration: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.35rem',
                        transition: 'all 0.2s',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                      }}
                      onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
                        e.currentTarget.style.borderColor = docsTheme.accent.strong
                        e.currentTarget.style.transform = 'translateY(-2px)'
                      }}
                      onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
                        e.currentTarget.style.borderColor = docsTheme.border.soft
                        e.currentTarget.style.transform = 'translateY(0)'
                      }}
                    >
                      <span style={{ fontSize: '0.85rem', color: docsTheme.text.muted, fontWeight: 600 }}>← Previous</span>
                      <span style={{ fontSize: '1.1rem', fontWeight: 600, color: docsTheme.text.heading }}>{nav.prev.title}</span>
                    </Link>
                  ) : <div />}
                  {nav.next && (
                    <Link
                      href={nav.next.href}
                      style={{
                        padding: '1.25rem',
                        borderRadius: '0.75rem',
                        border: `1px solid ${docsTheme.border.soft}`,
                        background: docsTheme.surfaces.page,
                        textDecoration: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.35rem',
                        textAlign: 'right',
                        transition: 'all 0.2s',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                      }}
                      onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
                        e.currentTarget.style.borderColor = docsTheme.accent.strong
                        e.currentTarget.style.transform = 'translateY(-2px)'
                      }}
                      onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
                        e.currentTarget.style.borderColor = docsTheme.border.soft
                        e.currentTarget.style.transform = 'translateY(0)'
                      }}
                    >
                      <span style={{ fontSize: '0.85rem', color: docsTheme.text.muted, fontWeight: 600 }}>Next →</span>
                      <span style={{ fontSize: '1.1rem', fontWeight: 600, color: docsTheme.text.heading }}>{nav.next.title}</span>
                    </Link>
                  )}
                </nav>
              )}
            </>
          ) : (
            <section
              style={{
                padding: '6rem 2rem',
                textAlign: 'center',
                maxWidth: '600px',
                margin: '0 auto',
              }}
            >
              <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>😕</div>
              <h1 style={{ fontSize: '2.25rem', fontWeight: 800, marginBottom: '1rem', color: docsTheme.text.heading }}>Page not found</h1>
              <p style={{ fontSize: '1.15rem', color: docsTheme.text.secondary, marginBottom: '2.5rem', lineHeight: 1.6 }}>
                The page you are looking for doesn't exist or has been moved.
              </p>
              <Link
                href={basePath}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.75rem 1.5rem',
                  borderRadius: '999px',
                  backgroundColor: docsTheme.accent.strong,
                  color: 'white',
                  textDecoration: 'none',
                  fontWeight: 600,
                  transition: 'transform 0.2s',
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.transform = 'scale(1.05)'}
                onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => e.currentTarget.style.transform = 'scale(1)'}
              >
                Back to Documentation
              </Link>
            </section>
          )}
        </article>
      </main>
    </>
  )
}
