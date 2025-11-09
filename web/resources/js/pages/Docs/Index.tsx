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

interface DocsIndexProps {
  categories: DocCategoryGroup[]
}

export default function DocsIndex({ categories }: DocsIndexProps) {
  useDocsPageTheme()

  return (
    <>
      <Head title="Documentation" />
      <main
        style={{
          fontFamily: docsTheme.fontFamily,
          margin: '3rem auto',
          maxWidth: '960px',
          padding: '0 1.5rem',
          backgroundColor: docsTheme.surfaces.page,
          color: docsTheme.text.primary,
        }}
      >
        <header style={{ marginBottom: '2.5rem' }}>
          <p
            style={{
              color: docsTheme.text.muted,
              fontSize: '0.875rem',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            Resources
          </p>
          <h1
            style={{
              fontSize: '2.5rem',
              margin: '0.5rem 0 1rem',
              fontWeight: 700,
              color: docsTheme.text.heading,
            }}
          >
            Guren Documentation
          </h1>
          <p
            style={{
              fontSize: '1.125rem',
              lineHeight: 1.7,
              color: docsTheme.text.secondary,
              maxWidth: '720px',
            }}
          >
            Browse the official guides and hands-on tutorials. Start with foundational topics, then follow the step-by-step builds
            to apply what you learned.
          </p>
        </header>
        {categories.map((group) => (
          <section key={group.category} style={{ marginBottom: '2.5rem' }}>
            <div style={{ marginBottom: '1.25rem' }}>
              <p
                style={{
                  color: docsTheme.text.muted,
                  fontSize: '0.75rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                }}
              >
                {group.title}
              </p>
              <h2 style={{ fontSize: '1.75rem', margin: 0, color: docsTheme.text.heading }}>
                {group.title === 'Guides' ? 'Deep dives & references' : 'Applied builds'}
              </h2>
            </div>
            {group.docs.length ? (
              <div style={{ display: 'grid', gap: '1.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
                {group.docs.map((doc) => (
                  <article
                    key={`${group.category}-${doc.slug}`}
                    style={{
                      border: `1px solid ${docsTheme.border.soft}`,
                      borderRadius: '0.75rem',
                      padding: '1.5rem',
                      backgroundColor: docsTheme.surfaces.panel,
                      boxShadow: docsTheme.shadow.card,
                    }}
                  >
                    <h3 style={{ fontSize: '1.25rem', marginBottom: '0.75rem', fontWeight: 600 }}>
                      <Link
                        href={`/docs/${group.category}/${doc.slug}`}
                        style={{ color: docsTheme.accent.strong, textDecoration: 'none' }}
                      >
                        {doc.title}
                      </Link>
                    </h3>
                    {doc.description ? (
                      <p style={{ fontSize: '0.95rem', color: docsTheme.text.secondary, lineHeight: 1.6 }}>{doc.description}</p>
                    ) : null}
                    <div style={{ marginTop: '1.25rem' }}>
                      <Link
                        href={`/docs/${group.category}/${doc.slug}`}
                        style={{ fontSize: '0.95rem', color: docsTheme.accent.base, fontWeight: 600, textDecoration: 'none' }}
                      >
                        Read {group.title.toLowerCase().slice(0, -1)} →
                      </Link>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p style={{ color: docsTheme.text.muted }}>No entries yet.</p>
            )}
          </section>
        ))}
      </main>
    </>
  )
}
