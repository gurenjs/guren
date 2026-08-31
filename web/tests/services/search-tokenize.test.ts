import { describe, expect, it } from 'vitest'

import { buildSearchMatch, tokenizeText } from '../../app/Services/search-tokenize.js'

describe('tokenizeText', () => {
  it('decomposes a CJK run into bigrams', () => {
    expect(tokenizeText('コントローラ').tokens).toBe('コン ント トロ ロー ーラ')
  })

  it('keeps the prolonged sound mark inside its katakana run', () => {
    // `ー` is Script=Common; only Script_Extensions puts it back with katakana.
    // Splitting there would produce `レー` / `ト制` from different runs and no
    // query for 「レート制限」could ever line up with the index.
    expect(tokenizeText('レート制限').tokens).toBe('レー ート ト制 制限')
  })

  it('records every CJK character as a unigram, including inside a run', () => {
    // This is what lets a one-character query find 「型安全」.
    expect(tokenizeText('型安全').unigrams).toBe('型 安 全')
  })

  it('leaves a one-character CJK run out of the bigram stream', () => {
    expect(tokenizeText('型')).toEqual({ tokens: '', unigrams: '型' })
  })

  it('splits identifiers on camel and digit boundaries, keeping the whole word', () => {
    expect(tokenizeText('createD1Database').tokens).toBe(
      'created1database create d1 database',
    )
  })

  it('keeps an acronym prefix whole', () => {
    expect(tokenizeText('HTTPServer').tokens).toBe('httpserver http server')
  })

  it('treats an underscore as a separator', () => {
    expect(tokenizeText('auth_guard').tokens).toBe('auth guard')
  })

  it('normalizes full-width and half-width forms', () => {
    expect(tokenizeText('Ｃｏｎｔｒｏｌｌｅｒ').tokens).toBe('controller')
    expect(tokenizeText('ｱｲｳ').tokens).toBe('アイ イウ')
  })

  it('segments a mixed line on the script boundary', () => {
    expect(tokenizeText('Guren の Controller')).toEqual({
      tokens: 'guren controller',
      unigrams: 'の',
    })
  })
})

describe('buildSearchMatch', () => {
  it('turns a CJK query into an adjacency phrase', () => {
    // Without the phrase, 「コントローラ」would also match a document that
    // merely contains 「コン」and 「トロ」far apart.
    expect(buildSearchMatch('コントローラ')).toEqual({
      mode: 'tokens',
      match: '"コン ント トロ ロー ーラ"',
    })
  })

  it('reads the unigram column when the whole query is one CJK character', () => {
    expect(buildSearchMatch('型')).toEqual({ mode: 'unigram', match: 'cjk_unigrams:"型"' })
  })

  it('drops a one-character CJK run from a longer query', () => {
    // 「型」has no bigram, so it cannot narrow a multi-term query; the unigram
    // column is reserved for the query that consists of nothing else. Pinned
    // so the asymmetry is a decision rather than a surprise.
    expect(buildSearchMatch('型 safety')).toEqual({ mode: 'tokens', match: '"safety"' })
  })

  it('scopes to a locale inside MATCH rather than filtering afterwards', () => {
    expect(buildSearchMatch('d1 database', 'en')).toEqual({
      mode: 'tokens',
      match: 'locale_tokens:"en" AND "d1" AND "database"',
    })
  })

  it('returns null when nothing in the query is searchable', () => {
    expect(buildSearchMatch('')).toBeNull()
    expect(buildSearchMatch('   ')).toBeNull()
    expect(buildSearchMatch('*^"-:')).toBeNull()
  })

  it('demotes FTS5 syntax to literal terms', () => {
    // Segmentation drops every character FTS5 would read as an operator, and
    // quoting each surviving term closes the path a second time. `tests/sqlite`
    // proves the result parses; here we pin the shape.
    expect(buildSearchMatch('a OR b')?.match).toBe('"a" AND "or" AND "b"')
    expect(buildSearchMatch('NEAR(auth, guard)')?.match).toBe(
      '"near" AND "auth" AND "guard"',
    )
    expect(buildSearchMatch('body:foo*')?.match).toBe('"body" AND "foo"')
  })
})
