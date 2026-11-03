import { describe, expect, it } from 'vitest'

import { firstSentence } from '../../resources/js/lib/first-sentence.js'

describe('firstSentence', () => {
  it('stops a paragraph that ends on a colon at its first full sentence', () => {
    expect(firstSentence('A Guren app keeps its configuration in config/. Two kinds of file live there:')).toBe(
      'A Guren app keeps its configuration in config/.',
    )
  })

  it('does not end a sentence inside an abbreviation or a dotted name', () => {
    expect(firstSentence('Runs on Node.js and Bun, e.g. on a VPS. Then more.')).toBe('Runs on Node.js and Bun, e.g. on a VPS.')
  })

  it('ends a Japanese sentence at the full stop', () => {
    expect(firstSentence('アプリの設定は config/ に置きます。ファイルは 2 種類あります。')).toBe('アプリの設定は config/ に置きます。')
  })

  it('returns a single sentence unchanged', () => {
    expect(firstSentence('Event classes')).toBe('Event classes')
  })
})
