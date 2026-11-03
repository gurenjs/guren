import { describe, expect, it } from 'vitest'

import { canonicalPath } from '../../app/Http/Middleware/canonical-path.js'
import { docCategoryLanding } from '../../app/Services/docs-config.js'

describe('canonicalPath', () => {
  it('should drop a trailing slash on page routes', () => {
    expect(canonicalPath('/blog/')).toBe('/blog')
    expect(canonicalPath('/docs/')).toBe('/docs')
    expect(canonicalPath('/docs/ja/')).toBe('/docs/ja')
    expect(canonicalPath('/docs/guides/bun/')).toBe('/docs/guides/bun')
    expect(canonicalPath('/blog/some-post//')).toBe('/blog/some-post')
    expect(canonicalPath('/start/')).toBe('/start')
  })

  it('should leave canonical paths and other trees alone', () => {
    expect(canonicalPath('/')).toBeUndefined()
    expect(canonicalPath('/docs')).toBeUndefined()
    expect(canonicalPath('/docs/guides/bun')).toBeUndefined()
    expect(canonicalPath('/blog/rss.xml')).toBeUndefined()
    expect(canonicalPath('/_guren/docs/')).toBeUndefined()
    expect(canonicalPath('/docs-images/')).toBeUndefined()
  })

  it('should send a bare category to its first page', () => {
    expect(canonicalPath('/docs/tutorials')).toBe(`/docs/tutorials/${docCategoryLanding('tutorials')}`)
    expect(canonicalPath('/docs/guides/')).toBe(`/docs/guides/${docCategoryLanding('guides')}`)
    expect(canonicalPath('/docs/ja/agent-course')).toBe(`/docs/ja/agent-course/${docCategoryLanding('agent-course')}`)
    expect(canonicalPath('/docs/search')).toBeUndefined()
  })

  it('should send guessed feed URLs to the feed', () => {
    expect(canonicalPath('/blog/feed/')).toBe('/blog/rss.xml')
    expect(canonicalPath('/feed')).toBe('/blog/rss.xml')
    expect(canonicalPath('/rss.xml')).toBe('/blog/rss.xml')
  })
})
