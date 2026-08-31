// Tokenization for the docs search index (D1 + SQLite FTS5).
//
// Indexing and querying go through the *same* segmentation here: if the two
// ever diverge, recall drops silently — nothing fails, results just stop
// appearing. Keep this module dependency-free, it runs both in the build
// script and inside the Worker.
//
// FTS5's own `trigram` tokenizer cannot match anything shorter than three
// characters, which rules it out for Japanese docs (「認証」「検証」are the
// common queries). So the index stores a pre-expanded token stream and uses
// `unicode61`, which keeps each emitted token whole: CJK codepoints are
// letters to it, and the separators we emit are plain spaces.

/**
 * Scripts written without spaces, where a run of characters has to be
 * decomposed into bigrams to be searchable at all. `scx=` rather than `sc=`
 * so 「ー」(Lm, Script=Common) stays inside its katakana run.
 *
 * Only ever consulted for characters that already passed `WORD_CHAR`: the
 * same script extensions also cover CJK punctuation, and 「。」joining a run
 * would put 「る。」in the index as a bigram no query can produce.
 */
const CJK_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u

/** Everything `unicode61` keeps as a token character; the rest separates. */
const WORD_CHAR = /[\p{L}\p{N}]/u

/**
 * camelCase / digit boundaries inside one word. Ordered so that the
 * "capital plus lowercase tail" alternative wins first: `createD1Database`
 * has to yield `D1`, not `D` followed by a stray `1`, while `HTTPServer`
 * still falls through to the all-caps alternative and yields `HTTP`.
 */
const SUBWORD = /\p{Lu}?[\p{Ll}\p{N}]+|\p{Lu}+(?!\p{Ll})/gu

export interface TokenizedText {
  /** Space-joined stream for the indexed token columns. */
  tokens: string
  /** Space-joined single CJK characters, for the 1-character query path. */
  unigrams: string
}

type Run = { kind: 'cjk' | 'word'; text: string }

/**
 * Split on script boundaries, dropping everything `unicode61` would treat as
 * a separator anyway. Dropping punctuation here is also what closes the FTS5
 * injection path: `"`, `*`, `^`, `:` and `-` cannot survive segmentation, so
 * no user input reaches the MATCH parser as syntax.
 */
function segment(text: string): Run[] {
  const runs: Run[] = []
  // Whether the previous character continued a run, as opposed to ending one:
  // a separator has to break `a b` into two runs even though both are words.
  let running = false

  for (const char of text.normalize('NFKC')) {
    if (!WORD_CHAR.test(char)) {
      running = false
      continue
    }

    const kind = CJK_CHAR.test(char) ? 'cjk' : 'word'
    const previous = runs.at(-1)
    if (running && previous !== undefined && previous.kind === kind) {
      previous.text += char
    } else {
      runs.push({ kind, text: char })
      running = true
    }
  }

  return runs
}

/**
 * The searchable forms of one latin word: the whole word, plus its camel and
 * digit-boundary parts when there is more than one. Docs about this framework
 * are full of identifiers, and without the parts `d1 database` cannot find
 * `createD1Database`.
 */
function wordTokens(word: string): string[] {
  const whole = word.toLowerCase()
  const parts = word.match(SUBWORD) ?? []
  if (parts.length < 2) {
    return [whole]
  }
  return [whole, ...parts.map((part) => part.toLowerCase())]
}

/** Adjacent character pairs. A run of one character produces none. */
function bigrams(run: string): string[] {
  const chars = [...run]
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i++) {
    out.push(chars[i] + chars[i + 1])
  }
  return out
}

/**
 * Index-side tokens for one piece of text.
 *
 * Single-character CJK runs deliberately produce no token in `tokens` — they
 * have no bigram — and are reachable only through `unigrams`. Every CJK
 * character lands in `unigrams`, including those inside longer runs, so
 * 「型」finds 「型安全」; repeats are kept so bm25 can rank by frequency.
 */
export function tokenizeText(text: string): TokenizedText {
  const tokens: string[] = []
  const unigrams: string[] = []

  for (const run of segment(text)) {
    if (run.kind === 'cjk') {
      tokens.push(...bigrams(run.text))
      unigrams.push(...run.text)
    } else {
      tokens.push(...wordTokens(run.text))
    }
  }

  return { tokens: tokens.join(' '), unigrams: unigrams.join(' ') }
}

/** FTS5 string literal. Tokens never contain a quote; double it regardless. */
function quote(token: string): string {
  return `"${token.replace(/"/gu, '""')}"`
}

/**
 * The FTS5 columns, in declaration order. bm25() takes its weights
 * positionally, so this order is the contract between the table the build
 * script creates and the weights below.
 */
export const SEARCH_COLUMNS = [
  'doc_title_tokens',
  'heading_tokens',
  'body_tokens',
  'locale_tokens',
  'cjk_unigrams',
] as const

/**
 * One weight vector per query shape, and they cannot be merged.
 *
 * bm25 returns the same value for every row when the only column that matched
 * is weighted 0.0 — the ordering does not degrade, it disappears, and results
 * come back in rowid order. So a single vector cannot serve both shapes: the
 * unigram column has to be weighted when it is the one being read, and
 * ignored when it is not.
 */
export const BM25_WEIGHTS = {
  tokens: [8.0, 4.0, 1.0, 0.0, 0.0],
  unigram: [0.0, 0.0, 0.0, 0.0, 1.0],
} as const

export type SearchLocale = 'en' | 'ja'

export interface SearchMatch {
  /**
   * `tokens` reads the bigram and word columns; `unigram` reads only
   * `cjk_unigrams`. The two need different bm25 weight vectors — weighting a
   * column 0.0 while it is the only one matched collapses every row to the
   * same rank and destroys the ordering — so callers must branch on this.
   */
  mode: 'tokens' | 'unigram'
  /** Ready to bind as the right-hand side of `MATCH`. */
  match: string
}

/**
 * Build the MATCH expression for a user query, or `null` when nothing in it
 * is searchable.
 *
 * CJK runs become phrases so that the bigrams have to appear adjacently:
 * without that, 「コントローラ」would also match a document that merely
 * contains 「コン」and 「トロ」far apart. A CJK run of one character has no
 * bigram, so it is dropped from a multi-run query and only drives the whole
 * query when it is all the user typed.
 */
export function buildSearchMatch(query: string, locale?: SearchLocale): SearchMatch | null {
  const runs = segment(query)

  const soleCjkChar =
    runs.length === 1 && runs[0].kind === 'cjk' && [...runs[0].text].length === 1
      ? runs[0].text
      : null

  const scope = locale ? `locale_tokens:${quote(locale)} AND ` : ''

  if (soleCjkChar) {
    return { mode: 'unigram', match: `${scope}cjk_unigrams:${quote(soleCjkChar)}` }
  }

  const terms: string[] = []
  for (const run of runs) {
    if (run.kind === 'cjk') {
      const pairs = bigrams(run.text)
      if (pairs.length > 0) {
        terms.push(quote(pairs.join(' ')))
      }
    } else {
      terms.push(quote(run.text.toLowerCase()))
    }
  }

  if (terms.length === 0) {
    return null
  }

  // FTS5's implicit operator is AND, but spelling it out keeps the expression
  // readable in logs and immune to a future default change.
  return { mode: 'tokens', match: `${scope}${terms.join(' AND ')}` }
}
