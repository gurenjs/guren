import { SITE_DESCRIPTION, pageTitle, formatPostDate } from '../../../../config/site.js'
import { Footer } from '../../components/Footer.js'
import { Header } from '../../components/Header.js'
import { Seo } from '../../components/Seo.js'
import { RssIcon } from '../../components/icons.js'

type BlogPostSummary = {
  slug: string
  title: string
  description: string | null
  publishedAt: string | null
}

interface Props {
  posts: BlogPostSummary[]
}

export default function BlogIndex({ posts }: Props) {
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
          <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
            <h1 className="text-[2.75rem] font-extrabold leading-[1.1] tracking-tight text-docs-heading">
              Blog
            </h1>
            {/* Browsers dropped their feed indicators, so the visible link is
                the only way a reader finds the feed. */}
            <a
              href="/blog/rss.xml"
              title="Subscribe via RSS"
              className="flex items-center gap-1.5 rounded-full border border-docs-border px-3.5 py-1.5 text-sm font-medium text-docs-text-secondary no-underline transition hover:border-docs-accent hover:text-docs-accent"
            >
              <RssIcon className="size-4" />
              RSS
            </a>
          </div>
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
                <p className="docs-mono mb-2 text-sm text-docs-text-secondary">{formatPostDate(post.publishedAt)}</p>
                <h2 className="mb-2 text-2xl font-bold text-docs-heading">
                  {/* Plain anchor: the post page is server-rendered HTML now (RFC 0014),
                      and an Inertia visit to it would reject the non-Inertia response. */}
                  <a href={`/blog/${post.slug}`} className="no-underline hover:underline">
                    {post.title}
                  </a>
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
