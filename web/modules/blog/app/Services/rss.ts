import { SITE_NAME, absoluteUrl } from '../../../../config/site.js'
import type { PublishedPost } from './published-posts.js'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * RSS 2.0 requires RFC-822 dates, not ISO-8601 — readers that parse strictly
 * drop items with an ISO timestamp. Always UTC, so no zone table is needed.
 */
export function toRfc822(date: Date): string {
  const day = DAYS[date.getUTCDay()]
  const month = MONTHS[date.getUTCMonth()]
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`

  return `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ${time} GMT`
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
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
 * also the feed's last build date — deriving it from the content rather than
 * from `now` keeps the body byte-identical between requests.
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
