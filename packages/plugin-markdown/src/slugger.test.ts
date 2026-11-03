import { describe, test, expect } from 'bun:test'

import { createSlugger } from './slugger'

describe('createSlugger', () => {
  test('should slugify plain text', () => {
    const slugify = createSlugger()
    expect(slugify('Getting Started')).toBe('getting-started')
  })

  test('should keep unicode letters and numbers', () => {
    const slugify = createSlugger()
    expect(slugify('はじめに 2026')).toBe('はじめに-2026')
  })

  test('should strip punctuation and collapse dashes', () => {
    const slugify = createSlugger()
    expect(slugify('What?! -- A "test": part 1')).toBe('what-a-test-part-1')
  })

  test('should deduplicate repeated headings deterministically', () => {
    const slugify = createSlugger()
    expect(slugify('Setup')).toBe('setup')
    expect(slugify('Setup')).toBe('setup-1')
    expect(slugify('Setup')).toBe('setup-2')
  })

  test('should skip suffixes a literal heading already claimed', () => {
    const slugify = createSlugger()
    expect(slugify('Setup')).toBe('setup')
    expect(slugify('Setup-1')).toBe('setup-1')
    expect(slugify('Setup')).toBe('setup-2')
  })

  test('should fall back to a deterministic slug for empty headings', () => {
    const slugify = createSlugger()
    expect(slugify('!!!')).toBe('heading')
    expect(slugify('???')).toBe('heading-1')
  })

  test('should never let markup characters reach the id', () => {
    const slugify = createSlugger()
    // Leftmost scan consumes `<scr<x>` as one tag; whatever text survives,
    // the charset filter guarantees no `<`, `>`, or quotes in the slug.
    const slug = slugify('<scr<x>ipt>alert</script> Title')
    expect(slug).toBe('iptalert-title')
    expect(slug).not.toMatch(/[<>"']/)
  })

  test('should decode the entities marked emits before slugging', () => {
    const slugify = createSlugger()
    expect(slugify('The audit&#39;s policy rule')).toBe('the-audits-policy-rule')
    expect(slugify('Inspection &amp; Audit Commands')).toBe('inspection-audit-commands')
    expect(slugify('&quot;CSRF token mismatch&quot;')).toBe('csrf-token-mismatch')
    expect(slugify('<code>Model&lt;T&gt;</code> API')).toBe('modelt-api')
  })

  test('should decode entities once and never turn them into markup', () => {
    const slugify = createSlugger()
    expect(slugify('a &amp;lt;b&amp;gt; c')).toBe('a-ltbgt-c')
    expect(slugify('&lt;script&gt;x&lt;/script&gt; Title')).toBe('scriptxscript-title')
    expect(slugify('&#0; &#x110000; &bogus; ok')).toBe('0-x110000-bogus-ok')
  })

  test('should keep unclosed tag tails verbatim, matching the regex form', () => {
    const slugify = createSlugger()
    expect(slugify('a <b')).toBe('a-b')
  })

  test('should scope uniqueness state per slugger instance', () => {
    const first = createSlugger()
    const second = createSlugger()
    expect(first('Setup')).toBe('setup')
    expect(second('Setup')).toBe('setup')
  })
})
