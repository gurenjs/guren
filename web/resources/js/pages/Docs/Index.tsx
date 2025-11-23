import { Head, Link } from '@inertiajs/react'
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

interface DocsIndexProps {
  categories: DocCategoryGroup[]
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

export default function DocsIndex({ categories, locales = [], basePath }: DocsIndexProps) {
  useDocsPageTheme()

  return (
    <>
      <Head title="Documentation" />
      <header
        style={{
          background: 'linear-gradient(135deg, rgba(183,28,28,0.14), rgba(15,10,10,0.9))',
          borderBottom: `1px solid ${docsTheme.border.soft}`,
          padding: '1.15rem 1.5rem',
        }}
      >
        <div
          style={{
            maxWidth: '1100px',
            margin: '0 auto',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            justifyContent: 'space-between',
            color: docsTheme.text.heading,
            flexWrap: 'wrap',
          }}
        >
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', textDecoration: 'none', color: 'inherit' }}>
            <img src="/logo.svg" alt="Guren logo" style={{ width: '36px', height: '36px', borderRadius: '12px', background: 'rgba(255,255,255,0.08)', padding: '6px' }} />
            <span style={{ fontSize: '1.05rem', fontWeight: 700 }}>Guren Docs</span>
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <nav style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <Link href={basePath} style={{ color: docsTheme.text.heading, textDecoration: 'none', fontWeight: 600 }}>
                Guides
              </Link>
              <Link href={`${basePath}/tutorials/overview`} style={{ color: docsTheme.text.heading, textDecoration: 'none', fontWeight: 600 }}>
                Tutorials
              </Link>
              <Link href="https://github.com/gurenjs/guren" style={{ color: docsTheme.text.heading, textDecoration: 'none', fontWeight: 600 }}>
                GitHub ↗
              </Link>
            </nav>
            {locales.length > 1 ? (
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                {locales.map((locale) => (
                  <Link
                    key={locale.code}
                    href={locale.href}
                    style={{
                      padding: '0.35rem 0.75rem',
                      borderRadius: '999px',
                      textDecoration: 'none',
                      color: locale.active ? docsTheme.surfaces.panel : docsTheme.text.primary,
                      backgroundColor: locale.active ? docsTheme.accent.strong : docsTheme.surfaces.panel,
                      border: `1px solid ${locale.active ? docsTheme.accent.strong : docsTheme.border.soft}`,
                      fontWeight: 600,
                      fontSize: '0.9rem',
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
        <header style={{ marginBottom: '2.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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
                      href={`${basePath}/${group.category}/${doc.slug}`}
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
                        href={`${basePath}/${group.category}/${doc.slug}`}
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
