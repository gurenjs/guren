/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import { Footer } from '../../../../app/View/Footer.js'
import { Header } from '../../../../app/View/Header.js'
import { Layout } from '../../../../app/View/Layout.js'
import { Seo } from '../../../../app/View/Seo.js'
import { SITE_DESCRIPTION, pageTitle } from '../../../../config/site.js'

/**
 * The public blog post page, server-rendered via `Controller.view()`
 * (RFC 0014) — the markup mirrors the retired Inertia page
 * `resources/js/pages/blog/Show.tsx`, minus the framework: no
 * `__INERTIA_PAGE__` payload, no hydration, plain `<a>` for links.
 */

export type BlogPostView = {
  slug: string
  title: string
  description: string | null
  publishedAt: string | null
  bodyHtml: string
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export const ShowPage: FC<{ post: BlogPostView | null }> = ({ post }) => (
  <Layout>
    {post ? (
      <Seo
        title={pageTitle(post.title)}
        description={post.description ?? SITE_DESCRIPTION.en}
        path={`/blog/${post.slug}`}
        locale="en"
        ogType="article"
      />
    ) : (
      <>
        <title>{pageTitle('Post not found')}</title>
        <meta name="robots" content="noindex" />
      </>
    )}
    <Header />

    <main class="mx-auto w-full max-w-[760px] px-6 py-16">
      {post ? (
        <article class="docs-article">
          <header class="mb-12">
            {post.publishedAt ? (
              <p class="docs-mono mb-3 text-sm text-docs-text-secondary">{formatDate(post.publishedAt)}</p>
            ) : null}
            <h1 class="mb-4 text-[2.75rem] font-extrabold leading-[1.1] tracking-tight text-docs-heading">
              {post.title}
            </h1>
            {post.description ? (
              <p class="text-xl leading-relaxed text-docs-text-secondary">{post.description}</p>
            ) : null}
          </header>
          <div class="docs-content" dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
          <p class="mt-16 border-t border-docs-border pt-8">
            <a href="/blog" class="font-semibold text-docs-accent no-underline hover:underline">
              ← All posts
            </a>
          </p>
        </article>
      ) : (
        <section class="mx-auto max-w-[600px] py-24 text-center">
          <div class="mb-4 text-6xl">404</div>
          <h1 class="mb-4 text-4xl font-extrabold text-docs-heading">Post not found</h1>
          <p class="mb-10 text-lg leading-relaxed text-docs-text-secondary">
            The post you are looking for doesn't exist or has been unpublished.
          </p>
          <a href="/blog" class="docs-btn-primary px-6 py-3">
            Back to the blog
          </a>
        </section>
      )}
    </main>

    <Footer />
  </Layout>
)
