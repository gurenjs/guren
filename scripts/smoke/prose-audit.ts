/**
 * `audit:prose`: the mechanical half of .claude/rules/prose.md, for docs/en and docs/ja.
 * ja: the phrases #767 removed, and the tells #1110/#1112 rewrote away (English words left
 * in prose, colour for test results, chains of short sentences, literal "you", two headings).
 * On the pre-#1110 docs those rules find 257 lines; on the rewritten ones, none.
 * en: the vocabulary and stock phrases the Wikipedia "Signs of AI writing" guide and the
 * Science Advances excess-vocabulary study name, and em-dash density (human 3-6/1000, LLM 9-10).
 * Course chapters: a prompt in a blockquote. Fenced and indented code and tables are skipped;
 * of a heading only its shape and the ja heading rules are judged.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

export type Locale = 'en' | 'ja'

export interface ProseRule {
  pattern: RegExp
  hint: string
  /** Judge the line without parenthesised glosses, 「quoted output」, bold labels and link text, where an English word is deliberate. */
  outsideGlosses?: boolean
}

export const JA_RULES: ProseRule[] = [
  { pattern: /[—–]/u, hint: 'ダッシュは散文で使わない。読点、文の分割、「:」、括弧に置き換える' },
  { pattern: /ことができます/u, hint: '「〜できます」「〜られます」で足りる' },
  { pattern: /することが可能/u, hint: '「〜できます」にする' },
  { pattern: /を提供します/u, hint: '何をするのかを具体的な動詞で書く' },
  { pattern: /これにより/u, hint: '前の文とつなげるか、主語を立てて書き直す(英語の This ... の直訳)' },
  { pattern: /様子を見|を目にし/u, hint: '英語の語り口(you will see)。「〜を確認します」など淡々と書く' },
  { pattern: /であることを意味/u, hint: '「つまり〜です」か、主語を立てて言い切る' },
  { pattern: /起こりえません|にすぎません/u, hint: '強調の訳し癖。「〜することはありません」「〜だけです」にする' },
  { pattern: /言い換えれば|要するに/u, hint: '言い直しは削り、最初から一度で言う' },
  { pattern: /ことに留意/u, hint: '「〜に注意してください」か、注意点そのものを書く' },
  { pattern: /興味深いことに|面白いのは/u, hint: '感想は書かず、事実だけを書く' },
  { pattern: /堅牢|シームレス|パワフル|エレガント|直感的|革命的|ゲームチェンジャー/u, hint: '空疎な形容。具体的に何がどうなるかを書く' },
  { pattern: /私たち|あなたは|あなたに/u, hint: '英語の we / you の直訳。主語を省くか、対象を具体的に書く' },
  { pattern: /いかがでしたか|と言えるでしょう|探っていきましょう/u, hint: 'ブログ調の定型。事実だけを書く' },
  {
    pattern: /(?<![\w./-])(?:verified|drifted|stalled|waived?|waiver|advisory|findings?|verdicts?|rubrics?|brief|subagents?|baseline|fail-closed|read-only)(?![\w./-])/iu,
    hint: '訳さずに残った英単語。地の文は日本語にし、画面に出る値だけ `verified` のように backtick で書く(初出は「検証済み (`verified`)」のように訳を添える)',
    outsideGlosses: true,
  },
  { pattern: /[緑赤](?:です|でした|になり|になる|になっ|のまま)/u, hint: 'テスト結果を色で言わない。「通る」「失敗する」と書く' },
  { pattern: /(?:[^。!?！？\n]{1,12}。){3}/u, hint: '短文が 3 つ以上続いている(英語の文の区切りの直訳)。接続助詞でつなぐか、1 文にまとめる' },
  { pattern: /自分の役目|自分のターミナル/u, hint: '英語の you の直訳。主語を省くか「手元の」「読者は」と書く' },
]

// Section titles the courses renamed away from; a heading's text is otherwise not judged.
export const JA_HEADING_RULES: ProseRule[] = [
  { pattern: /いまいる場所/u, hint: '章末の見出しは「ここまでの状態」' },
  { pattern: /、手で$/u, hint: '英語の見出しの直訳。「〜を手で組む」「〜を手で加える」のように動詞で終える' },
]

// A prompt the reader sends to an agent is a plain ```text fence, which gets the site's Copy button;
// a blockquote reads as a citation. GitHub alerts (`> [!TIP]`) stay blockquotes.
const COURSE_DIR = /(?:^|\/)docs\/(?:en|ja)\/(?:tutorials|agent-course)\//u
const BLOCKQUOTE_PROMPT_HINT = 'prompts go in a plain ```text fence after a line that says where to send them, not in a blockquote (docs/CLAUDE.md)'

function withoutGlosses(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, ' ')
    .replace(/\*\*[^*]+\*\*/gu, ' ')
    .replace(/\([^()]*\)|（[^（）]*）|「[^「」]*」/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
}

// Words the excess-vocabulary study and the Wikipedia guide both list; "robust",
// "comprehensive" and "seamless" are included because in these docs they only
// ever appear as filler in an opening sentence, never as a technical claim.
export const EN_RULES: ProseRule[] = [
  { pattern: /\b(?:delves?|delving|tapestry|leverag(?:e|es|ed|ing)|seamless(?:ly)?|robust(?:ly|ness)?|comprehensive(?:ly)?|crucial(?:ly)?|pivotal|underscor(?:es|ing)|showcas(?:e|es|ing)|testament|realm|intricate|vibrant|game-changer|paradigm shift|streamlin(?:e|es|ed|ing)|elevat(?:e|es|ing)|empower(?:s|ing)?|unlock(?:s|ing)?|harnessing)\b/iu, hint: 'AI-flavoured vocabulary: say what actually happens' },
  { pattern: /\b(?:in conclusion|in summary|to summarize|great question|i hope this helps|it'?s worth noting|it is worth noting|whether you'?re|let'?s dive in|let'?s explore|in today'?s|in the world of|at its core|when it comes to|plays a (?:crucial|vital|key) role|a wide range of|stands as a testament)\b/iu, hint: 'stock LLM phrase: cut it or state the fact' },
]

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
export const SHAPE_RULES: { kind: 'heading' | 'bullet'; pattern: RegExp; hint: string }[] = [
  { kind: 'heading', pattern: EMOJI, hint: 'no emoji in headings' },
  { kind: 'heading', pattern: /\*\*/u, hint: 'no bold inside a heading' },
  { kind: 'bullet', pattern: new RegExp(`^\\s*[-*]\\s+${EMOJI.source}`, 'u'), hint: 'no emoji list markers' },
]

// Per 1000 prose words; a short file gets a floor of 2 dashes so a single aside
// in a 200-word page is not a failure.
export const EM_DASH_PER_THOUSAND = 5
export const EM_DASH_FLOOR = 2

export interface ProseFinding {
  file: string
  line: number
  text: string
  hint: string
}

export interface ClassifiedLine {
  line: number
  text: string
  kind: 'prose' | 'heading' | 'table' | 'code'
}

export function classifyLines(source: string): ClassifiedLine[] {
  const out: ClassifiedLine[] = []
  let fence: string | null = null
  source.split('\n').forEach((text, index) => {
    const opener = text.match(/^\s*(`{3,}|~{3,})/u)
    if (fence === null && opener) { fence = opener[1]; return }
    if (fence !== null) {
      if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && text.trim() === opener[1]) fence = null
      return
    }
    const line = index + 1
    if (/^(\t| {4})/u.test(text)) out.push({ line, text, kind: 'code' })
    else if (/^\s*\|/u.test(text)) out.push({ line, text, kind: 'table' })
    else if (/^#{1,6}\s/u.test(text)) out.push({ line, text, kind: 'heading' })
    else out.push({ line, text, kind: 'prose' })
  })
  return out
}

export function localeOf(file: string): Locale | null {
  const m = file.match(/(?:^|\/)docs\/(en|ja)\//u)
  return m ? (m[1] as Locale) : null
}

export function auditProse(file: string, source: string, locale: Locale = localeOf(file) ?? 'en'): ProseFinding[] {
  const findings: ProseFinding[] = []
  const rules = locale === 'ja' ? JA_RULES : EN_RULES
  const course = COURSE_DIR.test(file)
  let words = 0
  let dashes = 0
  let inAlert = false
  for (const { line, text, kind } of classifyLines(source)) {
    if (kind === 'code' || kind === 'table') continue
    const stripped = text.replace(/`[^`\n]*`/gu, '`')
    for (const shape of SHAPE_RULES) {
      if ((shape.kind === 'heading') === (kind === 'heading') && shape.pattern.test(stripped)) findings.push({ file, line, text: text.trim(), hint: shape.hint })
    }
    if (kind === 'heading' && locale === 'ja') {
      for (const rule of JA_HEADING_RULES) {
        if (rule.pattern.test(stripped)) findings.push({ file, line, text: text.trim(), hint: rule.hint })
      }
    }
    if (kind !== 'prose') continue
    const quoted = /^>( |$)/u.test(text)
    if (text.startsWith('> [!')) inAlert = true
    else if (!quoted) inAlert = false
    else if (course && !inAlert) findings.push({ file, line, text: text.trim(), hint: BLOCKQUOTE_PROMPT_HINT })
    const glossFree = withoutGlosses(stripped)
    for (const rule of rules) {
      if (rule.pattern.test(rule.outsideGlosses ? glossFree : stripped)) findings.push({ file, line, text: text.trim(), hint: rule.hint })
    }
    if (locale === 'en') {
      words += (stripped.match(/[A-Za-z][A-Za-z'-]*/gu) ?? []).length
      dashes += (stripped.match(/—/gu) ?? []).length
    }
  }
  if (locale === 'en') {
    const allowed = Math.max(EM_DASH_FLOOR, Math.round((words * EM_DASH_PER_THOUSAND) / 1000))
    if (dashes > allowed) {
      findings.push({ file, line: 0, text: `${dashes} em-dashes in ${words} prose words (${((dashes * 1000) / words).toFixed(1)}/1000)`, hint: `em-dash density: at most ${allowed} for this file (${EM_DASH_PER_THOUSAND}/1000 words, floor ${EM_DASH_FLOOR}); rewrite with commas, colons, parentheses or a new sentence` })
    }
  }
  return findings
}

export function formatFinding(finding: ProseFinding): string {
  return `${finding.file}:${finding.line}: ${finding.hint}\n    ${finding.text.slice(0, 120)}`
}

async function defaultTargets(root: string): Promise<string[]> {
  const found: string[] = []
  for await (const path of new Bun.Glob('docs/{en,ja}/**/*.md').scan({ cwd: root })) found.push(path)
  return found.sort()
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..')
  const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : await defaultTargets(root)
  const findings: ProseFinding[] = []
  for (const file of targets) findings.push(...auditProse(file, await readFile(resolve(root, file), 'utf8')))
  if (findings.length > 0) {
    console.error(findings.map(formatFinding).join('\n'))
    console.error(`\n${findings.length} finding(s) in ${new Set(findings.map((f) => f.file)).size} file(s). Rules: .claude/rules/prose.md`)
    process.exit(1)
  }
  console.log(`Prose audit passed: ${targets.length} file(s).`)
}
