import { Head, Link } from '@inertiajs/react'
import { SITE_DESCRIPTION, pageTitle } from '../../../../config/site.js'
import { Footer } from '../../components/Footer.js'
import { Header } from '../../components/Header.js'
import { Seo } from '../../components/Seo.js'

type BlogPost = {
  slug: string
  title: string
  description: string | null
  publishedAt: string | null
  bodyHtml: string
}

interface Props {
  post: BlogPost | null
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export default function BlogShow({ post }: Props) {
  return (
    <>
      {post ? (
        <Seo
          title={pageTitle(post.title)}
          description={post.description ?? SITE_DESCRIPTION.en}
          path={`/blog/${post.slug}`}
          locale="en"
          ogType="article"
        />
      ) : (
        <Head title={pageTitle('Post not found')} />
      )}
      <Header variant="docs" />

      <main className="mx-auto w-full max-w-[760px] px-6 py-16">
        {post ? (
          <article className="docs-article">
            <header className="mb-12">
              {post.publishedAt && (
                <p className="docs-mono mb-3 text-sm text-docs-text-secondary">{formatDate(post.publishedAt)}</p>
              )}
              <h1 className="mb-4 text-[2.75rem] font-extrabold leading-[1.1] tracking-tight text-docs-heading">
                {post.title}
              </h1>
              {post.description && (
                <p className="text-xl leading-relaxed text-docs-text-secondary">{post.description}</p>
              )}
            </header>
            <div className="docs-content" dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
            <p className="mt-16 border-t border-docs-border pt-8">
              <Link href="/blog" className="font-semibold text-docs-accent no-underline hover:underline">
                ← All posts
              </Link>
            </p>
          </article>
        ) : (
          <section className="mx-auto max-w-[600px] py-24 text-center">
            <div className="mb-4 text-6xl">404</div>
            <h1 className="mb-4 text-4xl font-extrabold text-docs-heading">Post not found</h1>
            <p className="mb-10 text-lg leading-relaxed text-docs-text-secondary">
              The post you are looking for doesn't exist or has been unpublished.
            </p>
            <Link href="/blog" className="docs-btn-primary px-6 py-3">
              Back to the blog
            </Link>
          </section>
        )}
      </main>

      <Footer variant="docs" />
    </>
  )
}
