import { Head } from '@inertiajs/react'
import { OG_IMAGE_PATH, SITE_NAME, absoluteUrl } from '../../../config/site.js'

export interface SeoAlternate {
  hrefLang: string
  href: string
}

interface SeoProps {
  /** Full document title, e.g. "Routing — Guren" */
  title: string
  description: string
  /** Canonical path for this page, e.g. "/docs/guides/routing" */
  path: string
  locale?: 'en' | 'ja'
  /** hreflang alternates as site-relative paths. x-default is derived from the "en" entry. */
  alternates?: SeoAlternate[]
  ogType?: 'website' | 'article'
  /** Raw-markdown variant of this page, exposed for LLM agents. */
  markdownPath?: string
  jsonLd?: Record<string, unknown> | Array<Record<string, unknown>>
}

export function Seo({
  title,
  description,
  path,
  locale = 'en',
  alternates = [],
  ogType = 'website',
  markdownPath,
  jsonLd,
}: SeoProps) {
  const canonical = absoluteUrl(path)
  const ogImage = absoluteUrl(OG_IMAGE_PATH)
  const xDefault = alternates.find((alt) => alt.hrefLang === 'en')
  const jsonLdBlocks = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : []

  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />
      {alternates.map((alt) => (
        <link key={alt.hrefLang} rel="alternate" hrefLang={alt.hrefLang} href={absoluteUrl(alt.href)} />
      ))}
      {xDefault && <link rel="alternate" hrefLang="x-default" href={absoluteUrl(xDefault.href)} />}
      {markdownPath && (
        <link rel="alternate" type="text/markdown" href={absoluteUrl(markdownPath)} title="Markdown source" />
      )}
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={ogType} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:locale" content={locale === 'ja' ? 'ja_JP' : 'en_US'} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />
      {jsonLdBlocks.map((block, index) => (
        <script
          key={`jsonld-${index}`}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(block) }}
        />
      ))}
    </Head>
  )
}
