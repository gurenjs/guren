import { describe, expect, it } from 'vitest'
import { slugify, uniqueSlug } from './slug.js'

describe('slugify', () => {
  it('should lowercase and hyphenate titles', () => {
    expect(slugify('Guren 1.0 is Here!')).toBe('guren-10-is-here')
  })

  it('should collapse whitespace and trim hyphens', () => {
    expect(slugify('  Hello   World  ')).toBe('hello-world')
  })
})

describe('uniqueSlug', () => {
  it('should return the base slug when free', async () => {
    expect(await uniqueSlug('My Post', async () => false)).toBe('my-post')
  })

  it('should append an increasing suffix until free', async () => {
    const taken = new Set(['my-post', 'my-post-2'])
    const slug = await uniqueSlug('My Post', async (candidate) => taken.has(candidate))
    expect(slug).toBe('my-post-3')
  })

  it('should fall back to "post" for titles that slugify to nothing', async () => {
    expect(await uniqueSlug('!!!', async () => false)).toBe('post')
  })
})
