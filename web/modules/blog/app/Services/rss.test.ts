import { describe, expect, test } from 'vitest'
import { buildRssFeed, toRfc822 } from './rss.js'
import type { PublishedPost } from './published-posts.js'

function post(overrides: Partial<PublishedPost> = {}): PublishedPost {
  return {
    slug: 'starting-a-blog',
    title: 'Starting a blog',
    description: 'Why the Guren blog is built with Guren.',
    publishedAt: new Date('2026-07-26T09:05:00Z'),
    ...overrides,
  }
}

describe('toRfc822', () => {
  // RSS 2.0 mandates RFC-822 dates; an ISO-8601 string is the classic bug
  // here and readers that parse strictly drop the item.
  test('formats a date as RFC-822 in GMT', () => {
    expect(toRfc822(new Date('2026-07-26T09:05:00Z'))).toBe('Sun, 26 Jul 2026 09:05:00 GMT')
  })

  test('zero-pads single-digit day and time components', () => {
    expect(toRfc822(new Date('2026-01-05T03:07:09Z'))).toBe('Mon, 05 Jan 2026 03:07:09 GMT')
  })

  test('converts a non-UTC instant to GMT rather than shifting the label', () => {
    expect(toRfc822(new Date('2026-07-26T23:30:00+09:00'))).toBe('Sun, 26 Jul 2026 14:30:00 GMT')
  })
})

describe('buildRssFeed', () => {
  test('emits channel metadata and a self link', () => {
    const xml = buildRssFeed([post()])

    expect(xml).toContain('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">')
    expect(xml).toContain('<title>Guren Blog</title>')
    expect(xml).toContain('<link>https://guren.dev/blog</link>')
    expect(xml).toContain(
      '<atom:link href="https://guren.dev/blog/rss.xml" rel="self" type="application/rss+xml" />',
    )
  })

  test('emits an item with an absolute permalink guid and RFC-822 pubDate', () => {
    const xml = buildRssFeed([post()])

    expect(xml).toContain('<link>https://guren.dev/blog/starting-a-blog</link>')
    expect(xml).toContain(
      '<guid isPermaLink="true">https://guren.dev/blog/starting-a-blog</guid>',
    )
    expect(xml).toContain('<pubDate>Sun, 26 Jul 2026 09:05:00 GMT</pubDate>')
    expect(xml).toContain('<description>Why the Guren blog is built with Guren.</description>')
  })

  test('derives lastBuildDate from the newest post, not the current time', () => {
    const xml = buildRssFeed([
      post({ slug: 'newer', publishedAt: new Date('2026-07-26T09:05:00Z') }),
      post({ slug: 'older', publishedAt: new Date('2026-07-01T00:00:00Z') }),
    ])

    expect(xml).toContain('<lastBuildDate>Sun, 26 Jul 2026 09:05:00 GMT</lastBuildDate>')
  })

  test('escapes XML metacharacters in titles and descriptions', () => {
    const xml = buildRssFeed([
      post({ title: 'Types & <generics>', description: 'Use "strict" mode' }),
    ])

    expect(xml).toContain('<title>Types &amp; &lt;generics&gt;</title>')
    expect(xml).toContain('<description>Use &quot;strict&quot; mode</description>')
    expect(xml).not.toContain('<generics>')
  })

  test('omits the description element when a post has none', () => {
    const xml = buildRssFeed([post({ description: null })])

    expect(xml).not.toContain('<description></description>')
  })

  test('is well-formed with no posts', () => {
    const xml = buildRssFeed([])

    expect(xml).toContain('<channel>')
    expect(xml).not.toContain('<item>')
    expect(xml).not.toContain('<lastBuildDate>')
  })
})
