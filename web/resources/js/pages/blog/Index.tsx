import { Link } from '@inertiajs/react'
import { SITE_DESCRIPTION, pageTitle } from '../../../../config/site.js'
import { Footer } from '../../components/Footer.js'
import { Header } from '../../components/Header.js'
import { Seo } from '../../components/Seo.js'
import { useDocsPageTheme } from '../Docs/theme.js'

type BlogPostSummary = {
  slug: string
  title: string
  description: string | null
  publishedAt: string | null
}

interface Props {
  posts: BlogPostSummary[]
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default function BlogIndex({ posts }: Props) {
  useDocsPageTheme()

  return (
    <>
      <Seo
        title={pageTitle('Blog')}
        description={SITE_DESCRIPTION.en}
        path="/blog"
        locale="en"
      />
      <Header variant="docs" />

      <main className="mx-auto w-full max-w-[760px] px-6 py-16">
        <header className="mb-12">
          <h1 className="mb-3 text-[2.75rem] font-extrabold leading-[1.1] tracking-tight text-docs-heading">
            Blog
          </h1>
          <p className="text-lg leading-relaxed text-docs-text-secondary">
            News, releases, and notes from the Guren team.
          </p>
        </header>

        {posts.length === 0 ? (
          <p className="text-docs-text-muted">No posts yet — check back soon.</p>
        ) : (
          <div className="flex flex-col gap-8">
            {posts.map((post) => (
              <article key={post.slug} className="border-b border-docs-border pb-8">
                <p className="mb-2 text-sm text-docs-text-muted">{formatDate(post.publishedAt)}</p>
                <h2 className="mb-2 text-2xl font-bold text-docs-heading">
                  <Link href={`/blog/${post.slug}`} className="no-underline hover:underline">
                    {post.title}
                  </Link>
                </h2>
                {post.description && (
                  <p className="leading-relaxed text-docs-text-secondary">{post.description}</p>
                )}
              </article>
            ))}
          </div>
        )}
      </main>

      <Footer variant="docs" />
    </>
  )
}
