import { describe, expect, test } from 'bun:test'
import { auditProse, classifyLines, localeOf } from './prose-audit'

describe('prose-audit', () => {
  test('ja: flags a dash and a translated phrase in prose', () => {
    const findings = auditProse('docs/ja/x.md', 'マニフェストはデータです — CLI は実行しません。\n複数を組み合わせることができます。\n')
    expect(findings.map((f) => f.line)).toEqual([1, 2])
  })

  test('skips fenced code, indented code and tables; judges only the shape of a heading', () => {
    const source = [
      '## Heading — dash allowed, delve allowed',
      '| col | — | delve |',
      '    // comment — delve',
      '```ts',
      '// code — delve',
      '```',
      'Body text.',
    ].join('\n')
    expect(classifyLines(source).map((l) => l.kind)).toEqual(['heading', 'table', 'code', 'prose'])
    expect(auditProse('docs/en/x.md', source)).toEqual([])
    expect(auditProse('docs/ja/x.md', source)).toEqual([])
  })

  test('ignores inline code', () => {
    expect(auditProse('docs/en/x.md', 'Use `--delve` here.\n')).toEqual([])
    expect(auditProse('docs/ja/x.md', '`a — b` のように書きます。\n')).toEqual([])
  })

  test('a fence closed by a longer marker still closes', () => {
    const source = '````md\n```\n— inside\n```\n````\n— outside\n'
    expect(auditProse('docs/ja/x.md', source).map((f) => f.line)).toEqual([6])
  })

  test('en: vocabulary and stock phrases, case-insensitive, whole words', () => {
    const findings = auditProse('docs/en/x.md', 'Guren provides a robust queue.\nIn conclusion, it works.\nThe robustness of harness files is fine.\n')
    expect(findings.map((f) => f.line)).toEqual([1, 2, 3])
    expect(auditProse('docs/en/x.md', 'The agent harness ships rules.\n')).toEqual([])
  })

  test('en: em-dash density is a threshold with a floor, not a ban', () => {
    const words = Array.from({ length: 200 }, () => 'word').join(' ')
    expect(auditProse('docs/en/x.md', `${words} — one — two.\n`)).toEqual([])
    const dense = auditProse('docs/en/x.md', `${words} — one — two — three.\n`)
    expect(dense).toHaveLength(1)
    expect(dense[0].line).toBe(0)
    expect(auditProse('docs/en/x.md', `${words} ${words} ${words} ${words} ${words} — a — b — c — d — e.\n`)).toEqual([])
  })

  test('shape rules: emoji or bold in a heading, emoji bullets', () => {
    const findings = auditProse('docs/en/x.md', '## 🚀 Start\n## **Bold**\n- ✅ done\n- plain\n')
    expect(findings.map((f) => f.line)).toEqual([1, 2, 3])
  })

  test('localeOf reads the docs directory', () => {
    expect(localeOf('docs/ja/guides/a.md')).toBe('ja')
    expect(localeOf('/abs/docs/en/tutorials/a.md')).toBe('en')
    expect(localeOf('README.md')).toBeNull()
  })
})
