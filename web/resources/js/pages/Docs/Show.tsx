import { Head, Link } from '@inertiajs/react'
import { docsTheme, useDocsPageTheme } from './theme'

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
}

const docsContentStyles = `
  .docs-layout {
    font-family: ${docsTheme.fontFamily};
    margin: 0 auto;
    max-width: 1100px;
    padding: 3rem 1.5rem 4rem;
    display: grid;
    gap: 2.5rem;
    grid-template-columns: minmax(220px, 260px) minmax(0, 1fr);
    background-color: ${docsTheme.surfaces.page};
    color: ${docsTheme.text.primary};
  }
  .docs-sidebar {
    position: sticky;
    top: 2rem;
    align-self: start;
    max-height: calc(100vh - 4rem);
    overflow-y: auto;
    padding-right: 0.5rem;
  }
  .docs-article {
    min-width: 0;
    background-color: ${docsTheme.surfaces.panel};
    border-radius: 1rem;
    border: 1px solid ${docsTheme.border.soft};
    padding: 2.5rem 3rem;
    box-shadow: ${docsTheme.shadow.card};
  }
  @media (max-width: 1024px) {
    .docs-layout {
      grid-template-columns: 1fr;
      padding: 2.5rem 1.25rem 3rem;
    }
    .docs-sidebar {
      position: static;
      max-height: none;
      padding-right: 0;
    }
    .docs-article {
      padding: 2rem 1.75rem;
    }
  }
  .docs-content {
    min-width: 0;
    width: 100%;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .docs-content > * {
    max-width: 100%;
  }
  .docs-content pre,
  .docs-content .shiki {
    max-width: 100%;
    width: 100%;
    box-sizing: border-box;
  }
  .docs-content pre {
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .docs-content pre code {
    white-space: inherit;
  }
  .docs-content a {
    color: ${docsTheme.accent.strong};
    text-decoration-color: rgba(183, 28, 28, 0.45);
    text-underline-offset: 0.2em;
    font-weight: 600;
  }
  .docs-content a:hover,
  .docs-content a:focus-visible {
    color: ${docsTheme.accent.base};
    text-decoration-color: rgba(183, 28, 28, 0.8);
  }
  .docs-content a:focus-visible {
    outline: 2px solid ${docsTheme.accent.strong};
    outline-offset: 2px;
    border-radius: 0.2rem;
  }
  .shiki {
    border-radius: 1rem;
    border: 1px solid ${docsTheme.border.soft};
    margin: 0;
    padding: 1.15rem 1.4rem;
    overflow-x: auto;
    background: ${docsTheme.surfaces.raised};
  }
  .shiki code {
    font-family: "JetBrains Mono", "SFMono-Regular", ui-monospace, "SFMono", monospace;
    font-size: 0.95rem;
  }
  .shiki span {
    font-family: inherit;
  }
  .docs-content :not(pre) > code {
    background: ${docsTheme.accent.tint};
    border-radius: 0.4rem;
    padding: 0.1rem 0.35rem;
    font-family: "JetBrains Mono", "SFMono-Regular", ui-monospace, "SFMono", monospace;
    font-size: 0.95rem;
    color: ${docsTheme.text.heading};
    border: 1px solid ${docsTheme.border.soft};
  }
  .docs-alert {
    border-radius: 1rem;
    padding: 1.15rem 1.4rem;
    border: 1px solid rgba(60, 10, 10, 0.12);
    background: ${docsTheme.surfaces.panel};
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .docs-alert__label {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .docs-alert__body > :first-child {
    margin-top: 0;
  }
  .docs-alert__body > :last-child {
    margin-bottom: 0;
  }
  .docs-alert--note {
    border-color: #a0c4ff;
    background: #f0f6ff;
    color: #0f3057;
  }
  .docs-alert--note .docs-alert__label {
    color: #0f3057;
  }
  .docs-alert--tip {
    border-color: #9be7b4;
    background: #f1fff6;
    color: #0c3b24;
  }
  .docs-alert--tip .docs-alert__label {
    color: #0c3b24;
  }
  .docs-alert--important {
    border-color: #f7c873;
    background: #fff8ef;
    color: #5c3600;
  }
  .docs-alert--important .docs-alert__label {
    color: #5c3600;
  }
  .docs-alert--warning {
    border-color: #f8aa8b;
    background: #fff5f0;
    color: #5c1b00;
  }
  .docs-alert--warning .docs-alert__label {
    color: #5c1b00;
  }
  .docs-alert--caution {
    border-color: ${docsTheme.border.soft};
    background: #fff2f2;
    color: #5b0e0e;
  }
  .docs-alert--caution .docs-alert__label {
    color: #5b0e0e;
  }
  .docs-content img,
  .docs-content video {
    max-width: 100%;
    height: auto;
    border-radius: 0.75rem;
  }
  .docs-content table {
    width: 100%;
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
  }
  .docs-content table thead tr {
    background-color: rgba(183, 28, 28, 0.04);
  }
  .docs-content table th,
  .docs-content table td {
    padding: 0.65rem 0.85rem;
    text-align: left;
    border-bottom: 1px solid ${docsTheme.border.soft};
  }
`

export default function DocsShow({ categories, doc, active }: DocsShowProps) {
  useDocsPageTheme()

  const pageTitle = doc ? `${doc.title} – Documentation` : 'Document Not Found'
  const docLabel = doc?.category === 'tutorials' ? 'Tutorial' : 'Guide'

  return (
    <>
      <Head title={pageTitle} />
      <style dangerouslySetInnerHTML={{ __html: docsContentStyles }} />
      <main className="docs-layout">
        <aside className="docs-sidebar">
          {categories.map((group) => (
            <section key={group.category} style={{ marginBottom: '1.5rem' }}>
              <h2
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: docsTheme.accent.strong,
                  marginBottom: '0.5rem',
                }}
              >
                {group.title}
              </h2>
              <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {group.docs.map((entry) => {
                  const isActive = active?.category === group.category && active?.slug === entry.slug
                  const className = isActive ? 'docs-nav-link docs-nav-link--active' : 'docs-nav-link'
                  return (
                    <Link
                      key={`${group.category}-${entry.slug}`}
                      href={`/docs/${group.category}/${entry.slug}`}
                      className={className}
                      style={{
                        padding: '0.45rem 0.65rem',
                        borderRadius: '0.5rem',
                        textDecoration: 'none',
                        color: isActive ? docsTheme.accent.strong : docsTheme.text.primary,
                        backgroundColor: isActive ? docsTheme.accent.tint : 'transparent',
                        fontWeight: isActive ? 700 : 500,
                        fontSize: '0.95rem',
                        border: `1px solid ${isActive ? docsTheme.border.soft : 'transparent'}`,
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
              <header style={{ marginBottom: '2rem' }}>
                <p
                  style={{
                    color: docsTheme.accent.strong,
                    fontSize: '0.875rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    fontWeight: 600,
                  }}
                >
                  {docLabel}
                </p>
                <h1
                  style={{
                    fontSize: '2.25rem',
                    fontWeight: 700,
                    margin: '0.4rem 0 0.75rem',
                    color: docsTheme.text.heading,
                    lineHeight: 1.2,
                  }}
                >
                  {doc.title}
                </h1>
                {doc.description ? (
                  <p style={{ fontSize: '1.05rem', color: docsTheme.text.secondary, lineHeight: 1.6 }}>{doc.description}</p>
                ) : null}
              </header>
              <div
                className="docs-content"
                style={{
                  fontSize: '1rem',
                  lineHeight: 1.7,
                  color: docsTheme.text.primary,
                  display: 'grid',
                  gap: '1.5rem',
                }}
                dangerouslySetInnerHTML={{ __html: doc.html }}
              />
            </>
          ) : (
            <section
              style={{
                padding: '4rem 3rem',
                border: `1px solid ${docsTheme.border.soft}`,
                borderRadius: '1rem',
                background: docsTheme.surfaces.panel,
                textAlign: 'center',
              }}
            >
              <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '1rem', color: docsTheme.text.heading }}>Document not found</h1>
              <p style={{ fontSize: '1.05rem', color: docsTheme.text.secondary, marginBottom: '2rem' }}>
                We couldn&apos;t find the guide you were looking for. Try choosing another topic from the navigation or head back
                to the docs overview.
              </p>
              <Link
                href="/docs"
                className="docs-primary-link"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.65rem 1.25rem',
                  borderRadius: '999px',
                  backgroundColor: docsTheme.accent.strong,
                  color: 'var(--color-crimson-50)',
                  textDecoration: 'none',
                  fontWeight: 600,
                }}
              >
                Back to docs
              </Link>
            </section>
          )}
        </article>
      </main>
    </>
  )
}
