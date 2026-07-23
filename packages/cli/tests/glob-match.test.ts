import { describe, expect, it } from 'bun:test'
import { matchesGlob, matchesAnyGlob } from '../src/glob-match'

describe('matchesGlob', () => {
  it('matches a directory prefix with a trailing **', () => {
    expect(matchesGlob('app/Domain/Order.ts', 'app/Domain/**')).toBe(true)
    expect(matchesGlob('app/Domain/Nested/Order.ts', 'app/Domain/**')).toBe(true)
  })

  it('does not match a sibling directory with a similar prefix', () => {
    expect(matchesGlob('app/DomainFoo/Order.ts', 'app/Domain/**')).toBe(false)
  })

  it('does not match the layer root itself without a trailing segment', () => {
    expect(matchesGlob('app/Domain', 'app/Domain/**')).toBe(false)
  })

  it('matches a single path segment with *', () => {
    expect(matchesGlob('app/Models/Post.ts', 'app/Models/*.ts')).toBe(true)
    expect(matchesGlob('app/Models/nested/Post.ts', 'app/Models/*.ts')).toBe(false)
  })

  it('matches an exact literal path', () => {
    expect(matchesGlob('db/schema.ts', 'db/schema.ts')).toBe(true)
    expect(matchesGlob('db/schema.test.ts', 'db/schema.ts')).toBe(false)
  })

  it('escapes regex-special characters in literal segments', () => {
    expect(matchesGlob('app/Models/Post.ts', 'app/Models/Post.ts')).toBe(true)
    expect(matchesGlob('app/ModelsXts/Post.ts', 'app/Models.ts/Post.ts')).toBe(false)
  })
})

describe('matchesAnyGlob', () => {
  it('matches a single glob string', () => {
    expect(matchesAnyGlob('app/Http/Controllers/PostController.ts', 'app/Http/**')).toBe(true)
  })

  it('matches when any glob in an array matches', () => {
    const globs = ['app/Domain/**', 'app/Http/**']
    expect(matchesAnyGlob('app/Http/Controllers/PostController.ts', globs)).toBe(true)
    expect(matchesAnyGlob('app/Models/Post.ts', globs)).toBe(false)
  })
})
