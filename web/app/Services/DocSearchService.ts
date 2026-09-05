// Reads the docs search index that `scripts/build-search-index.ts` puts in D1.
//
// The tables are named after the build that produced them, and their names
// arrive through a generated module baked into the bundle — see that script
// for why the switch happens at deploy time rather than in SQL.
import { sql, type SQL } from '@guren/orm/drizzle/sqlite'

import { searchIndexBuild, type SearchIndexBuild } from '@/.guren/search-index.gen.js'

import { getDatabase } from '../../config/database.js'
import { docPaths } from '../../config/site.js'
import {
  BM25_WEIGHTS,
  buildSearchMatch,
  queryTerms,
  type SearchLocale,
} from './search-tokenize.js'

export interface DocSearchResult {
  category: string
  slug: string
  anchor: string
  docTitle: string
  heading: string
  snippet: string
  url: string
}

/**
 * `getDatabase()` hands back the driver as `unknown` — it is a D1 handle on
 * Workers and a bun-sqlite one locally. Only `all()` is needed here, and it
 * is awaited so both the sync and async drivers work.
 */
interface QueryableDatabase {
  all(query: SQL): unknown[] | Promise<unknown[]>
}

interface SectionRow {
  category: string
  slug: string
  anchor: string
  doc_title: string
  heading: string
  body: string
}

/** Characters of context, before ellipsis. Fits two lines in a result list. */
const SNIPPET_LENGTH = 160

/** How far into the snippet the match sits, so the reader sees its lead-in. */
const SNIPPET_LEAD = 48

/**
 * Thrown when the app is serving without an index. The generated module is a
 * stub in any checkout that has not run the build, and returning empty
 * results there would present a broken deploy as "nothing matched".
 */
export class SearchIndexUnavailableError extends Error {
  readonly statusCode = 503

  constructor() {
    super(
      'The docs search index has not been built. Run `bun run prerender && bun scripts/build-search-index.ts`, ' +
        'then load .guren/search-index.sql into the database this app opens.',
    )
    this.name = 'SearchIndexUnavailableError'
  }
}

/** Step off a lone surrogate so a slice never splits an astral character. */
function safeBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index)
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index
}

/**
 * A window of the section body around the first term the reader typed.
 *
 * Deliberately not FTS5's `snippet()`: the indexed columns hold bigrams, so
 * it would hand back 「コン ント トロ」rather than the sentence.
 */
export function buildSnippet(body: string, query: string, length = SNIPPET_LENGTH): string {
  const flat = body.replace(/\s+/gu, ' ').trim()
  if (flat.length <= length) {
    return flat
  }

  const lower = flat.toLowerCase()
  // Case folding is length-preserving for everything in these docs, but not in
  // general (İ folds to two code units). Rather than track a shifted index,
  // fall back to the head of the section when it is not.
  const positions =
    lower.length === flat.length
      ? queryTerms(query)
          .map((term) => lower.indexOf(term))
          .filter((index) => index >= 0)
      : []
  const at = positions.length > 0 ? Math.min(...positions) : -1

  if (at < 0) {
    return `${flat.slice(0, safeBoundary(flat, length)).trimEnd()}…`
  }

  const start = safeBoundary(flat, Math.max(0, at - SNIPPET_LEAD))
  const end = safeBoundary(flat, Math.min(flat.length, start + length))
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

export class DocSearchService {
  readonly #database: () => Promise<unknown>
  readonly #build: SearchIndexBuild

  constructor(database: () => Promise<unknown>, build: SearchIndexBuild) {
    this.#database = database
    this.#build = build
  }

  async search(query: string, locale: SearchLocale, limit = 20): Promise<DocSearchResult[]> {
    if (!this.#build.indexed) {
      throw new SearchIndexUnavailableError()
    }

    const match = buildSearchMatch(query, locale)
    if (match === null) {
      return []
    }

    const search = sql.identifier(this.#build.searchTable)
    const sections = sql.identifier(this.#build.sectionsTable)
    const [titleLead, title, heading, body, localeWeight, unigram] = BM25_WEIGHTS[match.mode]

    // A long section is several rows sharing one anchor; its heading is shown once, at
    // the best-ranked chunk. Deduplicating a fixed multiple of the limit in JS breaks
    // once a section has more chunks than that (26 matches became one result), and a
    // slug is not unique across categories, so the window partitions by category too.
    // FTS5 refuses an alias left of MATCH and bm25() works only directly over the table.
    const database = (await this.#database()) as QueryableDatabase
    const rows = (await database.all(sql`
      SELECT category, slug, anchor, doc_title, heading, body FROM (
        SELECT s.category AS category, s.slug AS slug, s.anchor AS anchor,
               s.doc_title AS doc_title, s.heading AS heading, s.body AS body,
               ranked.rank AS rank,
               row_number() OVER (
                 PARTITION BY s.category, s.slug, s.anchor ORDER BY ranked.rank
               ) AS chunk
        FROM (
          SELECT ${search}.rowid AS id,
                 bm25(${search}, ${titleLead}, ${title}, ${heading}, ${body}, ${localeWeight}, ${unigram}) AS rank
          FROM ${search}
          WHERE ${search} MATCH ${match.match}
        ) AS ranked
        JOIN ${sections} s ON s.id = ranked.id
      )
      WHERE chunk = 1
      ORDER BY rank
      LIMIT ${limit}
    `)) as SectionRow[]

    return rows.map((row) => ({
      category: row.category,
      slug: row.slug,
      anchor: row.anchor,
      docTitle: row.doc_title,
      heading: row.heading,
      snippet: buildSnippet(row.body, query),
      url: `${docPaths(row.category, row.slug)[locale]}#${encodeURIComponent(row.anchor)}`,
    }))
  }
}

export const docSearchService = new DocSearchService(getDatabase, searchIndexBuild)
