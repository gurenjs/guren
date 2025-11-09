import { Head, Link } from '@inertiajs/react'

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
  .shiki {
    border-radius: 1rem;
    border: 1px solid #F4B0B0;
    margin: 0;
    padding: 1.15rem 1.4rem;
    overflow-x: auto;
    background: #fffafa;
  }
  .shiki code {
    font-family: "JetBrains Mono", "SFMono-Regular", ui-monospace, "SFMono", monospace;
    font-size: 0.95rem;
  }
  .shiki span {
    font-family: inherit;
  }
  .docs-content :not(pre) > code {
    background: rgba(183, 28, 28, 0.08);
    border-radius: 0.4rem;
    padding: 0.1rem 0.35rem;
    font-family: "JetBrains Mono", "SFMono-Regular", ui-monospace, "SFMono", monospace;
    font-size: 0.95rem;
    color: #8F1111;
    border: 1px solid rgba(183, 28, 28, 0.15);
  }
  .docs-alert {
    border-radius: 1rem;
    padding: 1.15rem 1.4rem;
    border: 1px solid rgba(60, 10, 10, 0.12);
    background: #fff;
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
    border-color: #f4b0b0;
    background: #fff2f2;
    color: #5b0e0e;
  }
  .docs-alert--caution .docs-alert__label {
    color: #5b0e0e;
  }
`

export default function DocsShow({ categories, doc, active }: DocsShowProps) {
  const pageTitle = doc ? `${doc.title} – Documentation` : 'Document Not Found'
  const docLabel = doc?.category === 'tutorials' ? 'Tutorial' : 'Guide'

  return (
    <>
      <Head title={pageTitle} />
      <style dangerouslySetInnerHTML={{ __html: docsContentStyles }} />
      <main
        style={{
          fontFamily: 'system-ui, sans-serif',
          margin: '0 auto',
          maxWidth: '1100px',
          padding: '3rem 1.5rem 4rem',
          display: 'grid',
          gap: '2.5rem',
          gridTemplateColumns: 'minmax(220px, 260px) minmax(0, 1fr)',
        }}
      >
        <aside style={{ position: 'sticky', top: '2rem', alignSelf: 'start', maxHeight: 'calc(100vh - 4rem)', overflowY: 'auto' }}>
          {categories.map((group) => (
            <section key={group.category} style={{ marginBottom: '1.5rem' }}>
              <h2
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#B71C1C',
                  marginBottom: '0.5rem',
                }}
              >
                {group.title}
              </h2>
              <nav style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {group.docs.map((entry) => {
                  const isActive = active?.category === group.category && active?.slug === entry.slug
                  return (
                    <Link
                      key={`${group.category}-${entry.slug}`}
                      href={`/docs/${group.category}/${entry.slug}`}
                      style={{
                        padding: '0.45rem 0.65rem',
                        borderRadius: '0.5rem',
                        textDecoration: 'none',
                        color: isActive ? '#B71C1C' : '#3C0A0A',
                        backgroundColor: isActive ? 'rgba(183, 28, 28, 0.12)' : 'transparent',
                        fontWeight: isActive ? 700 : 500,
                        fontSize: '0.95rem',
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
        <article style={{ minWidth: 0 }}>
          {doc ? (
            <>
              <header style={{ marginBottom: '2rem' }}>
                <p style={{ color: '#B71C1C', fontSize: '0.875rem', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {docLabel}
                </p>
                <h1 style={{ fontSize: '2.25rem', fontWeight: 700, margin: '0.4rem 0 0.75rem', color: '#8F1111' }}>{doc.title}</h1>
                {doc.description ? (
                  <p style={{ fontSize: '1.05rem', color: '#7A0F0F', lineHeight: 1.6 }}>{doc.description}</p>
                ) : null}
              </header>
              <div
                className="docs-content"
                style={{
                  fontSize: '1rem',
                  lineHeight: 1.7,
                  color: '#3C0A0A',
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
                border: '1px solid #F4B0B0',
                borderRadius: '1rem',
                background: '#ffffff',
                textAlign: 'center',
              }}
            >
              <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '1rem', color: '#8F1111' }}>Document not found</h1>
              <p style={{ fontSize: '1.05rem', color: '#7A0F0F', marginBottom: '2rem' }}>
                We couldn&apos;t find the guide you were looking for. Try choosing another topic from the navigation or head back
                to the docs overview.
              </p>
              <Link
                href="/docs"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.65rem 1.25rem',
                  borderRadius: '999px',
                  backgroundColor: '#B71C1C',
                  color: '#FFF5F5',
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
