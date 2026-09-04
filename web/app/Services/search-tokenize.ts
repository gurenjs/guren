// Tokenization for the docs search index (D1 + SQLite FTS5).
// Indexing and querying share this segmentation; if they diverge, recall
// drops silently. Dependency-free on purpose: it runs in the build script and
// inside the Worker.
//
// FTS5's `trigram` tokenizer cannot match under three characters (「認証」is a
// common query), so the index stores a pre-expanded token stream under
// `unicode61`, which keeps each token whole: CJK codepoints are letters to it.

/**
 * Scripts written without spaces, whose runs are decomposed into bigrams.
 * `scx=` rather than `sc=` so 「ー」(Lm, Script=Common) stays inside its
 * katakana run. Only consulted for characters that already passed `WORD_CHAR`:
 * the same script extensions cover CJK punctuation, and 「。」joining a run
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
  // The run still being extended, or null once a separator ended one: `a b`
  // has to become two runs even though both characters are words.
  let current: Run | null = null

  for (const char of text.normalize('NFKC')) {
    if (!WORD_CHAR.test(char)) {
      current = null
      continue
    }

    const kind = CJK_CHAR.test(char) ? 'cjk' : 'word'
    if (current !== null && current.kind === kind) {
      current.text += char
    } else {
      current = { kind, text: char }
      runs.push(current)
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
 * Single-character CJK runs produce no token in `tokens` (no bigram) and are
 * reachable only through `unigrams`. Every CJK character lands in `unigrams`,
 * so 「型」finds 「型安全」; repeats are kept so bm25 can rank by frequency.
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

/**
 * The literal runs a query was written as, lowercased — not its tokens.
 * Snippets are cut from the stored body, which holds prose rather than
 * bigrams, so locating the hit takes the words the reader typed. Case is
 * folded because the body keeps its original casing.
 */
export function queryTerms(query: string): string[] {
  return segment(query).map((run) => run.text.toLowerCase())
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
  // Two title columns: `doc_title_lead` carries the title on the doc's first
  // section alone and takes the weight; `doc_title_tokens` carries it on every
  // section and takes none. FTS5 ANDs terms within a row, so with the title on
  // one row only `ルーティング ミドルウェア` cannot match; weighted on every
  // row, one title hit sweeps the result list with sections of a single doc.
  'doc_title_lead',
  'doc_title_tokens',
  'heading_tokens',
  'body_tokens',
  'locale_tokens',
  'cjk_unigrams',
] as const

/**
 * One weight vector per query shape; they cannot be merged. bm25 returns the
 * same value for every row when the only column that matched is weighted 0.0
 * — ordering does not degrade, it disappears (rowid order). The unigram
 * column has to be weighted when it is the one being read and ignored when
 * it is not.
 */
export const BM25_WEIGHTS = {
  tokens: [8.0, 0.0, 4.0, 1.0, 0.0, 0.0],
  unigram: [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
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
 * is searchable. CJK runs become phrases so the bigrams must appear adjacently
 * (otherwise 「コントローラ」also matches a doc holding 「コン」and 「トロ」far
 * apart). A one-character CJK run has no bigram: it is dropped from a
 * multi-run query and drives the query only when it is all the user typed.
 */
export function buildSearchMatch(query: string, locale?: SearchLocale): SearchMatch | null {
  const terms: string[] = []
  let ranked = false

  for (const run of segment(query)) {
    if (run.kind !== 'cjk') {
      terms.push(quote(run.text.toLowerCase()))
      ranked = true
      continue
    }

    const pairs = bigrams(run.text)
    if (pairs.length > 0) {
      terms.push(quote(pairs.join(' ')))
      ranked = true
    } else {
      // One character, so no bigram exists to constrain on. Dropping it made
      // `D1 型` a D1-only search and `値 型` no search at all, both of which
      // return documents the reader can see do not contain what they typed.
      terms.push(`cjk_unigrams:${quote(run.text)}`)
    }
  }

  if (terms.length === 0) {
    return null
  }

  const scope = locale ? `locale_tokens:${quote(locale)} AND ` : ''
  // FTS5's implicit operator is AND, but spelling it out keeps the expression
  // readable in logs and immune to a future default change.
  const match = `${scope}${terms.join(' AND ')}`

  // The unigram column only drives the ranking when nothing else matched:
  // weighting a column 0.0 when it is the only one hit collapses every row to
  // the same score. A mixed query has a bigram or a word to rank by instead.
  return { mode: ranked ? 'tokens' : 'unigram', match }
}
