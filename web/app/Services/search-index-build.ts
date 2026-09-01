// Turn prerendered docs into the SQL that populates the D1 search index.
//
// Build-time only — `web/scripts/build-search-index.ts` is the I/O around it.
// The logic lives here rather than in the script because `scripts/` is outside
// the app's tsconfig `include`, and this is the part that has to be right:
// the build id decides whether a deploy reindexes at all, and the SQL is
// handed to a parser (D1's) that we do not control.
import { createHash } from 'node:crypto'

import { splitDocSections } from './search-sections.js'
import { SEARCH_COLUMNS, tokenizeText } from './search-tokenize.js'

/**
 * Bumped whenever the stored shape changes — columns, tokenization, section
 * splitting. Without it, a change to this pipeline would leave the previous
 * shape in D1 behind an id that still matches.
 */
export const INDEX_FORMAT = 2

/**
 * D1 rejects a SQL statement over 100,000 bytes. Rows are batched up to this
 * budget, which leaves room for the statement prefix and for the token stream
 * running several times the size of the body it came from.
 */
export const MAX_STATEMENT_BYTES = 80_000

export interface PrerenderedDocLike {
  title: string
  html: string
}

/** `docsData.docs` — locale, then category, then slug. */
export type DocsByLocale = Record<string, Record<string, Record<string, PrerenderedDocLike>>>

export interface IndexRow {
  id: number
  locale: string
  category: string
  slug: string
  anchor: string
  docTitle: string
  heading: string
  body: string
  docTitleLead: string
  docTitleTokens: string
  headingTokens: string
  bodyTokens: string
  unigrams: string
}

/**
 * A NUL truncates a SQL string literal inside the parser rather than failing,
 * so `quote()` drops them — and the build id has to hash what is stored, or
 * two corpora that produce byte-identical SQL would get different ids and
 * reindex for nothing.
 */
function withoutNul(value: string): string {
  return value.replace(/\u0000/gu, '')
}

export function collectRows(docs: DocsByLocale): IndexRow[] {
  const rows: IndexRow[] = []

  // Sorted at every level. The build id hashes these rows in order, so an
  // unstable traversal would read as a content change and force a reindex.
  for (const locale of Object.keys(docs).sort()) {
    const categories = docs[locale]
    for (const category of Object.keys(categories).sort()) {
      const slugs = categories[category]
      for (const slug of Object.keys(slugs).sort()) {
        const doc = slugs[slug]
        const docTitle = tokenizeText(doc.title)

        for (const [position, section] of splitDocSections(doc.html).entries()) {
          const heading = tokenizeText(section.heading)
          const body = tokenizeText(section.body)
          // The title is searchable on the doc's first section only — its h1,
          // which is where a "this whole guide" hit should land. Repeating it
          // on every section made a title match fan out across the document:
          // searching `database` returned six sections of guides/database
          // ahead of every other doc, led by whichever of them bm25 happened
          // to favour, with snippets that had nothing to do with the query.
          rows.push({
            id: rows.length + 1,
            locale,
            category,
            slug,
            anchor: section.anchor,
            docTitle: withoutNul(doc.title),
            heading: withoutNul(section.heading),
            body: withoutNul(section.body),
            // Only the first section takes the weighted copy; every section
            // takes the unweighted one, so a query pairing the title with a
            // later heading still has a row that satisfies both.
            docTitleLead: position === 0 ? docTitle.tokens : '',
            docTitleTokens: docTitle.tokens,
            headingTokens: heading.tokens,
            bodyTokens: body.tokens,
            unigrams: [docTitle.unigrams, heading.unigrams, body.unigrams]
              .filter((part) => part.length > 0)
              .join(' '),
          })
        }
      }
    }
  }

  return rows
}

/**
 * A pure function of what gets indexed, and of nothing else — no clock, no
 * git sha, no build counter.
 *
 * The deploy workflow skips reindexing when the id it just built matches the
 * one already in D1, and then deploys a Worker naming tables suffixed with
 * that id. If anything outside the corpus could move the id, such a deploy
 * would bake a name for tables nobody ever created, and every search would
 * fail until the next docs change. This is the one invariant in the design
 * that turns into an outage when it breaks.
 */
export function computeBuildId(rows: IndexRow[]): string {
  const hash = createHash('sha256')
  hash.update(`format:${INDEX_FORMAT}\n`)
  for (const row of rows) {
    hash.update(
      JSON.stringify([
        row.locale,
        row.category,
        row.slug,
        row.anchor,
        row.docTitle,
        row.heading,
        row.body,
        row.docTitleLead,
        row.docTitleTokens,
        row.headingTokens,
        row.bodyTokens,
        row.unigrams,
      ]),
    )
    hash.update('\n')
  }
  return hash.digest('hex').slice(0, 16)
}

export function sectionsTableName(buildId: string): string {
  return `doc_sections_${buildId}`
}

export function searchTableName(buildId: string): string {
  return `doc_search_${buildId}`
}

/** SQL string literal. A NUL would truncate it inside the parser, silently. */
function quote(value: string): string {
  return `'${value.replace(/\u0000/gu, '').replace(/'/gu, "''")}'`
}

/**
 * Group `VALUES (…)` tuples into statements that stay under the byte budget.
 * A tuple over the budget on its own cannot be split here — that is what the
 * section body cap upstream exists to prevent, so fail loudly at build time
 * rather than emit SQL that D1 rejects mid-deploy.
 */
function batchInserts(prefix: string, tuples: string[]): string[] {
  const statements: string[] = []
  const prefixBytes = Buffer.byteLength(prefix, 'utf8')
  let batch: string[] = []
  let bytes = prefixBytes

  const flush = (): void => {
    if (batch.length > 0) {
      statements.push(`${prefix}\n${batch.join(',\n')};`)
      batch = []
      bytes = prefixBytes
    }
  }

  for (const tuple of tuples) {
    const size = Buffer.byteLength(tuple, 'utf8') + 2
    if (size + prefixBytes > MAX_STATEMENT_BYTES) {
      throw new Error(
        `A single row serializes to ${size} bytes, over the ${MAX_STATEMENT_BYTES} byte ` +
          'statement budget. Lower MAX_SECTION_BODY in app/Services/search-sections.ts.',
      )
    }
    if (bytes + size > MAX_STATEMENT_BYTES) {
      flush()
    }
    batch.push(tuple)
    bytes += size
  }
  flush()

  return statements
}

/**
 * The whole index as one script: both tables created under this build's own
 * names, filled, and the state row updated.
 *
 * Nothing is dropped here except this build's own tables (so re-running is
 * safe). Retiring the *previous* build's tables is a post-deploy step: doing
 * it at the head of this file would mean a failed deploy leaves the live
 * Worker pointing at tables that no longer exist.
 */
export function renderIndexSql(rows: IndexRow[], buildId: string): string {
  const sections = sectionsTableName(buildId)
  const search = searchTableName(buildId)

  const statements: string[] = [
    '-- Generated by web/scripts/build-search-index.ts — do not edit.',
    `-- ${rows.length} sections, build ${buildId}.`,
    `DROP TABLE IF EXISTS "${sections}";`,
    `CREATE TABLE "${sections}" (
  id INTEGER PRIMARY KEY,
  locale TEXT NOT NULL,
  category TEXT NOT NULL,
  slug TEXT NOT NULL,
  anchor TEXT NOT NULL,
  doc_title TEXT NOT NULL,
  heading TEXT NOT NULL,
  body TEXT NOT NULL
);`,
    `DROP TABLE IF EXISTS "${search}";`,
    // Contentless: the columns are searchable but not stored. Keeping the body
    // and its expanded token stream in one FTS5 table costs 69% more space and
    // buys nothing — snippets are cut from doc_sections instead, since
    // snippet() would return bigrams.
    `CREATE VIRTUAL TABLE "${search}" USING fts5(
${SEARCH_COLUMNS.map((column) => `  ${column},`).join('\n')}
  content='',
  tokenize='unicode61'
);`,
  ]

  statements.push(
    ...batchInserts(
      `INSERT INTO "${sections}" (id, locale, category, slug, anchor, doc_title, heading, body) VALUES`,
      rows.map(
        (row) =>
          `(${row.id}, ${quote(row.locale)}, ${quote(row.category)}, ${quote(row.slug)}, ` +
          `${quote(row.anchor)}, ${quote(row.docTitle)}, ${quote(row.heading)}, ${quote(row.body)})`,
      ),
    ),
    ...batchInserts(
      // The rowid is written explicitly: it is the only key a contentless table
      // has, and it is what joins back to doc_sections.id.
      `INSERT INTO "${search}" (rowid, ${SEARCH_COLUMNS.join(', ')}) VALUES`,
      rows.map(
        (row) =>
          `(${row.id}, ${quote(row.docTitleLead)}, ${quote(row.docTitleTokens)}, ` +
          `${quote(row.headingTokens)}, ${quote(row.bodyTokens)}, ` +
          `${quote(row.locale)}, ${quote(row.unigrams)})`,
      ),
    ),
    // The pointer rotates here rather than in the deploy script: whatever this
    // build replaces has to stay nameable, because `wrangler rollback` brings
    // an earlier Worker back and does not bring D1 with it.
    `INSERT INTO "search_index_state" (id, build_id, previous_build_id, updated_at)
  VALUES (1, ${quote(buildId)}, NULL, unixepoch())
  ON CONFLICT(id) DO UPDATE SET
    previous_build_id = "search_index_state".build_id,
    build_id = excluded.build_id,
    updated_at = excluded.updated_at;`,
  )

  return `${statements.join('\n')}\n`
}
