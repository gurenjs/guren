import { describe, expect, it } from 'vitest'

import { buildSnippet } from '../../app/Services/DocSearchService.js'

const LONG = 'Lorem ipsum dolor sit amet. '.repeat(20)

describe('buildSnippet', () => {
  it('returns a short body whole, with no ellipsis', () => {
    expect(buildSnippet('Deploy the app to Workers.', 'workers')).toBe(
      'Deploy the app to Workers.',
    )
  })

  it('collapses the line breaks the body was stored with', () => {
    expect(buildSnippet('Deploy\nthe app\n\nto Workers.', 'workers')).toBe(
      'Deploy the app to Workers.',
    )
  })

  it('centres the window on the first term the reader typed', () => {
    const snippet = buildSnippet(`${LONG} needle here ${LONG}`, 'needle')

    expect(snippet).toContain('needle here')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('matches regardless of the case the body uses', () => {
    // The stored body keeps its original casing; the query does not.
    expect(buildSnippet(`${LONG} createD1Database ${LONG}`, 'CreateD1Database')).toContain(
      'createD1Database',
    )
  })

  it('finds a Japanese term as the reader wrote it, not as bigrams', () => {
    const body = `${LONG}コントローラーはリクエストを受け取る。${LONG}`

    expect(buildSnippet(body, 'コントローラー')).toContain('コントローラーはリクエスト')
  })

  it('falls back to the head of the body when no term appears', () => {
    // Can happen: the match may have come from the heading or the doc title.
    const snippet = buildSnippet(LONG, 'nothingmatcheshere')

    expect(snippet.startsWith('Lorem ipsum')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
  })

  it('never splits a surrogate pair', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

    // The trailing cut: 159 single-unit characters put the first emoji across
    // indices 159 and 160, so a 160-character window ends inside it.
    expect(buildSnippet(`${'a'.repeat(159)}${'🎉'.repeat(50)}`, 'a')).not.toMatch(lone)

    // The leading cut: the window opens 48 characters before the hit, and the
    // padding is sized so that opening lands on the *second* code unit of an
    // emoji. One character less and it lands on the first, where an unguarded
    // slice is accidentally valid and the assertion proves nothing.
    expect(buildSnippet(`${'🎉'.repeat(100)}xy needle ${'b'.repeat(300)}`, 'needle')).not.toMatch(
      lone,
    )
  })
})
