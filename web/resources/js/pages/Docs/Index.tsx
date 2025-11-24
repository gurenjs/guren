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
            maxWidth: '1200px',
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
      <main
        style={{
          fontFamily: docsTheme.fontFamily,
          backgroundColor: docsTheme.surfaces.page,
          color: docsTheme.text.primary,
          minHeight: 'calc(100vh - 70px)',
        }}
      >
        <div style={{
          maxWidth: '1200px',
          margin: '0 auto',
          padding: '4rem 1.5rem 6rem',
        }}>
          <header style={{ marginBottom: '5rem', maxWidth: '800px' }}>
            <p
              style={{
                color: docsTheme.accent.strong,
                fontSize: '0.9rem',
                fontWeight: 600,
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <span style={{ width: '20px', height: '1px', backgroundColor: docsTheme.accent.strong }}></span>
              DOCUMENTATION
            </p>
            <h1
              style={{
                fontSize: '3.5rem',
                margin: '0 0 1.5rem',
                fontWeight: 800,
                color: docsTheme.text.heading,
                letterSpacing: '-0.03em',
                lineHeight: 1.1,
              }}
            >
              Build faster with <br />
              <span style={{
                background: 'linear-gradient(135deg, #db1b1b 0%, #7f1d1d 100%)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent'
              }}>Guren Framework</span>
            </h1>
            <p
              style={{
                fontSize: '1.25rem',
                lineHeight: 1.6,
                color: docsTheme.text.secondary,
                maxWidth: '640px',
              }}
            >
              Everything you need to build robust, scalable applications.
              Explore our comprehensive guides and hands-on tutorials to get started.
            </p>
          </header>

          <div style={{ display: 'grid', gap: '4rem' }}>
            {categories.map((group) => (
              <section key={group.category}>
                <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
                  <h2 style={{ fontSize: '1.5rem', margin: 0, fontWeight: 700, color: docsTheme.text.heading, letterSpacing: '-0.02em' }}>
                    {group.title === 'Guides' ? 'Core Concepts & Guides' : 'Tutorials & Examples'}
                  </h2>
                  <div style={{ flex: 1, height: '1px', backgroundColor: docsTheme.border.soft, opacity: 0.6 }}></div>
                </div>

                {group.docs.length ? (
                  <div style={{ display: 'grid', gap: '1.5rem', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                    {group.docs.map((doc) => (
                      <Link
                        key={`${group.category}-${doc.slug}`}
                        href={`${basePath}/${group.category}/${doc.slug}`}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <article
                          style={{
                            height: '100%',
                            border: `1px solid ${docsTheme.border.soft}`,
                            borderRadius: '12px',
                            padding: '1.75rem',
                            backgroundColor: docsTheme.surfaces.panel,
                            transition: 'all 0.2s ease',
                            display: 'flex',
                            flexDirection: 'column',
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'translateY(-4px)'
                            e.currentTarget.style.boxShadow = docsTheme.shadow.floating
                            e.currentTarget.style.borderColor = docsTheme.accent.strong
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'translateY(0)'
                            e.currentTarget.style.boxShadow = 'none'
                            e.currentTarget.style.borderColor = docsTheme.border.soft
                          }}
                        >
                          <h3 style={{ fontSize: '1.15rem', marginBottom: '0.75rem', fontWeight: 600, color: docsTheme.text.heading }}>
                            {doc.title}
                          </h3>
                          {doc.description ? (
                            <p style={{ fontSize: '0.95rem', color: docsTheme.text.secondary, lineHeight: 1.6, flex: 1 }}>{doc.description}</p>
                          ) : null}
                          <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem', fontWeight: 600, color: docsTheme.accent.strong }}>
                            Read more <span>→</span>
                          </div>
                        </article>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: docsTheme.text.muted, fontStyle: 'italic' }}>No documentation available in this section yet.</p>
                )}
              </section>
            ))}
          </div>
        </div>
      </main>
    </>
  )
}
