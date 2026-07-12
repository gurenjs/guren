import { GITHUB_URL, SITE_DESCRIPTION, SITE_NAME, SITE_URL, absoluteUrl } from '../../../config/site.js'

export function websiteJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION.en,
  }
}

export function softwareJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows (WSL2)',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description: SITE_DESCRIPTION.en,
    url: SITE_URL,
    sameAs: [GITHUB_URL],
    programmingLanguage: 'TypeScript',
  }
}

export function techArticleJsonLd(options: {
  title: string
  description?: string
  path: string
  locale: 'en' | 'ja'
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: options.title,
    description: options.description,
    url: absoluteUrl(options.path),
    inLanguage: options.locale,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    author: { '@type': 'Organization', name: SITE_NAME, url: GITHUB_URL },
  }
}

export function breadcrumbJsonLd(
  items: Array<{ name: string; path: string }>,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  }
}
