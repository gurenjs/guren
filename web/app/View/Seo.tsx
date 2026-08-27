/** @jsxImportSource @guren/core */
import type { FC } from '@guren/core'
import { OG_IMAGE_PATH, SITE_NAME, absoluteUrl } from '../../config/site.js'

/**
 * Server-rendered port of `resources/js/components/Seo.tsx` for content
 * pages: the same `<title>`/`<meta>`/`<link>` set, relying on hono's native
 * head hoisting instead of Inertia's `<Head>` — render it anywhere in the
 * page and the tags land in `<head>`.
 *
 * Deliberately ports only the props content pages use today; `locale`,
 * `alternates`, `markdownPath`, and `jsonLd` stay with the React component
 * until a content page needs them (the RSS discovery link lives in
 * `Layout.tsx`'s head — it is site-wide, and 404 pages skip `Seo`) (JSON-LD additionally needs
 * `dangerouslySetInnerHTML` with `<` escaped as `\u003c`, because hono
 * HTML-escapes text children).
 */
interface SeoProps {
  /** Full document title, e.g. "Routing — Guren" */
  title: string
  description: string
  /** Canonical path for this page, e.g. "/blog/hello-world" */
  path: string
  ogType?: 'website' | 'article'
}

export const Seo: FC<SeoProps> = ({ title, description, path, ogType = 'website' }) => {
  const canonical = absoluteUrl(path)
  const ogImage = absoluteUrl(OG_IMAGE_PATH)

  return (
    <>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:locale" content="en_US" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />
    </>
  )
}
