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

  test('ja: an English status word left in prose, but not in a gloss, a quote, a link, bold or inline code', () => {
    const lines = (source: string) => auditProse('docs/ja/x.md', source).map((f) => f.line)
    expect(lines('verified でない間は最大 3 回まで差し戻します。\n')).toEqual([1])
    expect(lines('advisory ではない警告を出します。\n')).toEqual([1])
    expect(lines('検証済み (`verified`) の意味。\n参考扱い (advisory) の警告。\n「Approved plan drifted」が出ます。\n')).toEqual([])
    expect(lines('[Agent Skills](https://agentskills.io/) の標準。\n**advisory**: 参考扱い。\n状態は `drifted` です。\n')).toEqual([])
    expect(lines('`plan-write` の read-only-ish な mode.\n')).toEqual([])
  })

  test('ja: test results said in colours, chains of short sentences, and a literal "you"', () => {
    const lines = (source: string) => auditProse('docs/ja/x.md', source).map((f) => f.line)
    expect(lines('テストは緑です。\n2 件が赤になります。\n画面には赤いボタンがあります。\n')).toEqual([1, 2])
    expect(lines('ステップは導かれます。誰も書きません。1 つ取ります。\n')).toEqual([1])
    expect(lines('ステップは Guren が計画から組み立てるので、人が書く必要はありません。1 つずつ実装します。\n')).toEqual([])
    expect(lines('自分の役目はコミットを読むことです。\n')).toEqual([1])
  })

  test('ja: translated chapter headings', () => {
    const lines = (source: string) => auditProse('docs/ja/tutorials/x.md', source).map((f) => f.line)
    expect(lines('## いまいる場所\n## 6. 最初の変更を、手で\n## ここまでの状態\n## 6. 最初の変更を手で加える\n')).toEqual([1, 2])
    expect(auditProse('docs/en/tutorials/x.md', '## Where you are\n')).toEqual([])
  })

  test('course chapters: a blockquote prompt, but not a GitHub alert and not outside the courses', () => {
    const source = 'Send this:\n\n> Plan this feature.\n>\n> More.\n\n> [!TIP]\n> A tip line.\n'
    expect(auditProse('docs/en/agent-course/02.md', source).map((f) => f.line)).toEqual([3, 4, 5])
    expect(auditProse('docs/ja/tutorials/02.md', source).map((f) => f.line)).toEqual([3, 4, 5])
    expect(auditProse('docs/en/guides/x.md', source)).toEqual([])
  })

  test('localeOf reads the docs directory', () => {
    expect(localeOf('docs/ja/guides/a.md')).toBe('ja')
    expect(localeOf('/abs/docs/en/tutorials/a.md')).toBe('en')
    expect(localeOf('README.md')).toBeNull()
  })
})
