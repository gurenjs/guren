import { SITE_NAME, absoluteUrl } from '../../../../config/site.js'
import { xmlEscape } from '../../../../config/xml.js'
import type { PublishedPost } from './published-posts.js'

/**
 * RSS 2.0 requires RFC-822 dates, not ISO-8601; strict readers drop the item.
 * ES2018 fixed toUTCString() at exactly that form, locale-independent.
 */
export function toRfc822(date: Date): string {
  return date.toUTCString()
}

function item(post: PublishedPost): string {
  const url = absoluteUrl(`/blog/${post.slug}`)

  return [
    '    <item>',
    `      <title>${xmlEscape(post.title)}</title>`,
    `      <link>${xmlEscape(url)}</link>`,
    `      <guid isPermaLink="true">${xmlEscape(url)}</guid>`,
    `      <pubDate>${toRfc822(post.publishedAt)}</pubDate>`,
    post.description ? `      <description>${xmlEscape(post.description)}</description>` : '',
    '    </item>',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * RSS 2.0 for the blog. Posts arrive newest-first, so the head of the list is
 * the last build date; deriving it from content rather than `now` keeps the
 * body byte-identical between requests.
 */
export function buildRssFeed(posts: PublishedPost[]): string {
  const feedUrl = absoluteUrl('/blog/rss.xml')
  const channel: string[] = [
    `    <title>${SITE_NAME} Blog</title>`,
    `    <link>${absoluteUrl('/blog')}</link>`,
    '    <description>Release notes, design decisions, and field notes from building Guren.</description>',
    '    <language>en</language>',
    `    <atom:link href="${xmlEscape(feedUrl)}" rel="self" type="application/rss+xml" />`,
  ]

  const newest = posts[0]
  if (newest) {
    channel.push(`    <lastBuildDate>${toRfc822(newest.publishedAt)}</lastBuildDate>`)
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    ...channel,
    ...posts.map(item),
    '  </channel>',
    '</rss>',
    '',
  ].join('\n')
}
