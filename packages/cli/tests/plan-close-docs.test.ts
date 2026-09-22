import { describe, expect, test } from 'bun:test'

import { extractUncitedRules } from '../src/docs-acceptance'
import { readEntityDoc, spliceEntityBlock } from '../src/plan/close-docs'

const HAND = ['---', 'type: entity', 'entities: [Comment]', '---', '', '# Comment', '', 'Kept.', '', '## Rules', '', '- Mine. (AC-comments-9)', '', '## Glossary', '', 'Also kept.', ''].join('\n')

function splice(document: string, hash: string, content?: string[], slug = 'comments'): string {
  return spliceEntityBlock(document, { slug, hash, section: 'rules', content, locale: 'en' })
}

describe('spliceEntityBlock', () => {
  test('should insert a block at the end of its section, before the next heading', () => {
    const out = splice(HAND, 'aaa', ['- New. (AC-comments-1)'])

    expect(out).toBe(HAND.replace('- Mine. (AC-comments-9)\n', '- Mine. (AC-comments-9)\n\n<!-- guren:plan comments aaa rules -->\n- New. (AC-comments-1)\n<!-- /guren:plan comments rules -->\n'))
  })

  test('should replace only between the markers, whatever hash the block was written under', () => {
    const first = splice(HAND, 'aaa', ['- Old. (AC-comments-1)'])

    const second = splice(first, 'bbb', ['- New. (AC-comments-2)'])

    expect(second).toBe(splice(HAND, 'bbb', ['- New. (AC-comments-2)']))
    expect(second).not.toContain('aaa')
  })

  test('should leave the block of another plan alone', () => {
    const other = splice(HAND, 'aaa', ['- Theirs. (AC-comments-5)'], 'moderation')

    const out = splice(other, 'bbb', ['- Ours. (AC-comments-1)'])

    expect(out).toContain('<!-- guren:plan moderation aaa rules -->\n- Theirs. (AC-comments-5)\n<!-- /guren:plan moderation rules -->')
    expect(out).toContain('<!-- guren:plan comments bbb rules -->\n- Ours. (AC-comments-1)\n<!-- /guren:plan comments rules -->')
  })

  test('should be a fixed point when run twice with the same content', () => {
    const once = splice(HAND, 'aaa', ['- New. (AC-comments-1)'])

    expect(splice(once, 'aaa', ['- New. (AC-comments-1)'])).toBe(once)
  })

  test('should append a heading in the plan locale when the document has no such section', () => {
    const out = spliceEntityBlock('# Comment\n', { slug: 'comments', hash: 'aaa', section: 'history', content: ['- x'], locale: 'ja' })

    expect(out).toBe('# Comment\n\n## 履歴\n\n<!-- guren:plan comments aaa history -->\n- x\n<!-- /guren:plan comments history -->\n')
  })

  test('should remove its block when a revision has nothing left to say there, and nothing else', () => {
    const withBlock = splice(HAND, 'aaa', ['- Old. (AC-comments-1)'])

    expect(splice(withBlock, 'bbb')).toBe(HAND)
  })
})

describe('fences', () => {
  const FENCED = ['# Comment', '', '## Rules', '', '- Mine. (AC-comments-9)', '', '```sh', '# seed the db', 'bun run db:seed', '```', '', '~~~', '## Rules', '~~~', '', '## Glossary', ''].join('\n')

  test('should not end a section at a heading-shaped line inside a code fence', () => {
    const out = splice(FENCED, 'aaa', ['- New. (AC-comments-1)'])

    expect(out).toContain('~~~\n## Rules\n~~~\n\n<!-- guren:plan comments aaa rules -->\n- New. (AC-comments-1)\n<!-- /guren:plan comments rules -->\n\n## Glossary')
  })

  test('should not take a fenced heading for the section', () => {
    const document = ['# Comment', '', '```md', '## Rules', '```', ''].join('\n')

    expect(splice(document, 'aaa', ['- x'])).toBe(`${document.trimEnd()}\n\n## Rules\n\n<!-- guren:plan comments aaa rules -->\n- x\n<!-- /guren:plan comments rules -->\n`)
  })
})

describe('readEntityDoc', () => {
  test('should name an open marker with no close before the next heading, a stray close, a pair seen twice and a fenced marker', () => {
    const problems = (body: string): string[] => readEntityDoc(body).problems

    expect(problems('<!-- guren:plan comments aaa rules -->\n- x\n## Next\n<!-- /guren:plan comments rules -->\n')).toEqual([
      'line 1: the block "comments rules" opens and never closes',
      'line 4: the block "comments rules" closes and never opened',
    ])
    const block = '<!-- guren:plan comments aaa rules -->\n- x\n<!-- /guren:plan comments rules -->\n'
    expect(problems(`${block}${block}`)).toEqual(['line 4: the block "comments rules" appears twice'])
    expect(problems('~~~\n<!-- guren:plan comments aaa rules -->\n~~~\n')).toEqual(['line 2: a guren:plan marker sits inside a code fence'])
    expect(problems(block)).toEqual([])
  })

  test('should refuse to splice a document it cannot read safely', () => {
    expect(() => splice('<!-- guren:plan comments aaa rules -->\n- a person\'s text\n', 'bbb', ['- x'])).toThrow(/opens and never closes/u)
  })
})

describe('extractUncitedRules', () => {
  test('should report a rule under a Rules heading that cites no acceptance id', () => {
    expect(extractUncitedRules(HAND.replace('## Glossary', '- Nobody tests this.\n\n## Glossary'))).toEqual(['Nobody tests this.'])
  })

  test('should read a Japanese Rules heading and ignore lists under other headings or in code', () => {
    const body = ['## ルール', '', '- 未検証の規則', '', '```', '- not a rule', '```', '~~~', '## Glossary', '- nor this', '~~~', '', '## Glossary', '', '- not a rule either'].join('\n')

    expect(extractUncitedRules(body)).toEqual(['未検証の規則'])
  })
})
