/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import { ContentShell } from '../../../../app/View/ContentShell.js'
import { Seo } from '../../../../app/View/Seo.js'
import { SITE_DESCRIPTION, formatPostDate, pageTitle } from '../../../../config/site.js'

/**
 * The public blog post page, server-rendered via `Controller.view()`: the
 * retired Inertia page's markup minus the framework — no page-payload script,
 * no hydration, plain `<a>`. Metadata goes through the `ContentShell` head slot.
 */

type BlogPostView = {
  slug: string
  title: string
  description: string | null
  publishedAt: string | null
  bodyHtml: string
}

export const ShowPage: FC<{ post: BlogPostView }> = ({ post }) => (
  <ContentShell
    head={
      <Seo
        title={pageTitle(post.title)}
        description={post.description ?? SITE_DESCRIPTION.en}
        path={`/blog/${post.slug}`}
        ogType="article"
      />
    }
  >
    <main class="mx-auto w-full max-w-[760px] px-6 py-16">
      <article class="docs-article">
        <header class="mb-12">
          {post.publishedAt ? (
            <p class="docs-mono mb-3 text-sm text-docs-text-secondary">{formatPostDate(post.publishedAt)}</p>
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
    </main>
  </ContentShell>
)

/** The 404 counterpart, its own component because `view()` binds per call. */
export const PostNotFoundPage: FC = () => (
  <ContentShell
    head={
      <>
        <title>{pageTitle('Post not found')}</title>
        <meta name="robots" content="noindex" />
      </>
    }
  >
    <main class="mx-auto w-full max-w-[760px] px-6 py-16">
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
    </main>
  </ContentShell>
)
