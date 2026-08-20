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
