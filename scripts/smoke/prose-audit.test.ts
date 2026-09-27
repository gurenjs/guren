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


  test('ja: an English status word left in prose, whatever its case', () => {
    const lines = (source: string) => auditProse('docs/ja/x.md', source).map((f) => f.line)
    expect(lines('verified でない間は最大 3 回まで差し戻します。\n')).toEqual([1])
    expect(lines('Verified の状態です。\n')).toEqual([1])
    expect(lines('advisory ではない警告を出します。\n')).toEqual([1])
  })

  test('ja: an English word is exempt in a gloss, a quote, a link, bold, a tag or inside another word', () => {
    const lines = (source: string) => auditProse('docs/ja/x.md', source).map((f) => f.line)
    expect(lines('参考扱い (advisory) の警告。\n参考扱い（advisory）の警告。\n参考扱い（advisory) の警告。\n')).toEqual([])
    expect(lines('参考扱い (advisory、ゲートを落とさない (後述)) の警告。\n')).toEqual([])
    expect(lines('「Approved plan drifted」が出ます。\n')).toEqual([])
    expect(lines('[verified の手順](./a.md) を参照。\n**advisory**: 参考扱い。\n<span title="verified">済</span>です。\n')).toEqual([])
    expect(lines('Bun を installed の状態で使います。\n`plan-write` の read-only-ish な mode.\n`/plans?state=verified` を開きます。\n')).toEqual([])
  })

  test('ja: a gloss split by a hard wrap is still a gloss, and a finding names the line the word is on', () => {
    const lines = (source: string) => auditProse('docs/ja/x.md', source).map((f) => f.line)
    expect(lines('参考扱い (advisory\nの続き) の警告です。\n')).toEqual([])
    expect(lines('前の行は日本語です。\nここで verified と書いています。\n')).toEqual([2])
    expect(lines('段落の終わり。\n\nverified が次の段落です。\n')).toEqual([3])
  })

  test('ja: code fenced inside a blockquote is code', () => {
    const source = '> [!NOTE]\n> ```ts\n> const findings = await runAudit({ baseline })\n> ```\n'
    expect(auditProse('docs/ja/guides/x.md', source)).toEqual([])
  })

  test('ja: test results said in colours, and a literal "you"', () => {
    const lines = (source: string) => auditProse('docs/ja/x.md', source).map((f) => f.line)
    expect(lines('テストは緑です。\n2 件が赤になります。\n画面には赤いボタンがあります。\n')).toEqual([1, 2])
    expect(lines('自分の役目はコミットを読むことです。\n')).toEqual([1])
  })

  test('ja: translated chapter headings, in ja only', () => {
    const lines = (file: string, source: string) => auditProse(file, source).map((f) => f.line)
    expect(lines('docs/ja/tutorials/01-x.md', '## いまいる場所\n## 6. 最初の変更を、手で\n## ここまでの状態\n## 6. 最初の変更を手で加える\n## 6. 最初の変更を、手で加える\n')).toEqual([1, 2])
    expect(lines('docs/en/tutorials/01-x.md', '## いまいる場所\n')).toEqual([])
  })

  test('course chapters: a blockquote that is not a GitHub alert, in chapters only', () => {
    const source = 'Send this:\n\n> Plan this feature.\n>\n> More.\n\n> [!TIP]\n> A tip line.\n\n>Unspaced.\n'
    expect(auditProse('docs/en/agent-course/02-the-first-plan.md', source).map((f) => f.line)).toEqual([3, 4, 5, 10])
    expect(auditProse('docs/ja/tutorials/02-one-request.md', source).map((f) => f.line)).toEqual([3, 4, 5, 10])
    expect(auditProse('docs/en/guides/x.md', source)).toEqual([])
    expect(auditProse('docs/en/tutorials/overview.md', source)).toEqual([])
  })

  test('course chapters: an alert ends at a blank line or a heading, not at a fence inside it', () => {
    const lines = (source: string) => auditProse('docs/en/tutorials/03-x.md', source).map((f) => f.line)
    expect(lines('> [!TIP]\n> A tip.\n\n> A prompt after the alert.\n')).toEqual([4])
    expect(lines('> [!TIP]\n## Heading\n> A prompt after the heading.\n')).toEqual([3])
    expect(lines('> [!NOTE]\n> ```ts\n> const a = 1\n> ```\n> Still the note.\n')).toEqual([])
  })
  test('localeOf reads the docs directory', () => {
    expect(localeOf('docs/ja/guides/a.md')).toBe('ja')
    expect(localeOf('/abs/docs/en/tutorials/a.md')).toBe('en')
    expect(localeOf('README.md')).toBeNull()
  })
})
