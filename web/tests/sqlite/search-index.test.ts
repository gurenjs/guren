/**
 * The search index against a real FTS5 engine.
 *
 * Runs under `bun test`, not vitest: vitest executes in Node, whose bundled
 * SQLite is compiled without FTS5 (`no such module: fts5`), so none of this
 * could run there. `bun:sqlite` ships the same 3.51.0 build D1 does.
 *
 * What only an engine can settle: that the generated SQL parses at all, that
 * the contentless table joins back to its rows, that a hostile query is inert
 * rather than a syntax error, and that the two bm25 weight vectors are not
 * interchangeable.
 */
import { Database } from 'bun:sqlite'

import { drizzle } from 'drizzle-orm/bun-sqlite'
import { sql } from 'drizzle-orm'

import { beforeAll, describe, expect, test } from 'bun:test'

import {
  collectRows,
  computeBuildId,
  renderIndexSql,
  searchTableName,
  sectionsTableName,
  type DocsByLocale,
} from '../../app/Services/search-index-build.js'
import { BM25_WEIGHTS, buildSearchMatch } from '../../app/Services/search-tokenize.js'
import { applyMigrations } from './migrations.js'

const docs: DocsByLocale = {
  en: {
    guides: {
      cloudflare: {
        title: 'Cloudflare',
        html:
          '<h1 id="cloudflare">Cloudflare</h1><p>Deploy to Workers.</p>' +
          '<h2 id="database-d1">Database (D1)</h2>' +
          `<p>Call <code>createD1Database</code> with a binding; it returns <code>getDatabase()</code>.</p>`,
      },
    },
    // A title match plus several sections, against another doc whose *heading*
    // matches the same word — the shape that exposes title fan-out.
    tutorials: {
      database: {
        title: 'Database',
        html:
          '<h1 id="database">Database</h1><p>Connect and query.</p>' +
          '<h2 id="mutators">Accessors and mutators</h2><p>Shape a column on the way out.</p>' +
          '<h2 id="serialization">Serialization</h2><p>Turn a record into JSON.</p>' +
          '<h2 id="relations">Relationships</h2><p>Join one table to another.</p>',
      },
      health: {
        title: 'Health checks',
        html:
          '<h1 id="health-checks">Health checks</h1><p>Probe a running app.</p>' +
          '<h2 id="database-check">Database check</h2><p>Confirm the connection answers.</p>',
      },
    },
  },
  ja: {
    guides: {
      controllers: {
        title: 'コントローラー',
        html:
          '<h1 id="コントローラー">コントローラー</h1><p>コントローラーはリクエストを受け取る。</p>' +
          '<h2 id="型安全">型安全</h2><p>型安全なリクエストパースを行う。</p>',
      },
      routing: {
        title: 'ルーティング',
        html: '<h1 id="ルーティング">ルーティング</h1><p>ルートを定義する。型は生成される。</p>',
      },
    },
  },
}

const rows = collectRows(docs)
const buildId = computeBuildId(rows)
const sections = sectionsTableName(buildId)
const search = searchTableName(buildId)

let db: Database

function find(query: string, locale: 'en' | 'ja'): { slug: string; anchor: string }[] {
  const match = buildSearchMatch(query, locale)
  if (match === null) {
    return []
  }
  // FTS5 rejects a table alias on the left of MATCH ("no such column"), so the
  // real table name has to appear twice.
  return db
    .query(
      `SELECT s.slug AS slug, s.anchor AS anchor
       FROM "${search}" JOIN "${sections}" s ON s.id = "${search}".rowid
       WHERE "${search}" MATCH ?
       ORDER BY bm25("${search}", ${BM25_WEIGHTS[match.mode].join(', ')})
       LIMIT 10`,
    )
    .all(match.match) as { slug: string; anchor: string }[]
}

beforeAll(() => {
  db = new Database(':memory:')
  // The committed migrations, so `search_index_state` is exercised as shipped.
  applyMigrations(db)
  db.exec(renderIndexSql(rows, buildId))
})

describe('generated index SQL', () => {
  test('fills both tables with matching row counts', () => {
    const counts = db
      .query(
        `SELECT (SELECT count(*) FROM "${sections}") AS sections,
                (SELECT count(*) FROM "${search}") AS fts`,
      )
      .get() as { sections: number; fts: number }

    expect(counts.sections).toBe(rows.length)
    expect(counts.fts).toBe(rows.length)
  })

  test('records the build id in the state row', () => {
    expect(db.query('SELECT build_id FROM search_index_state').get()).toEqual({
      build_id: buildId,
    })
  })

  test('keeps the state table to a single row', () => {
    expect(() => db.exec(`INSERT INTO search_index_state (id, build_id, updated_at) VALUES (2, 'x', 0)`)).toThrow()
  })
})

describe('queries', () => {
  test('finds a Japanese phrase through its bigrams', () => {
    expect(find('コントローラー', 'ja')[0]).toEqual({
      slug: 'controllers',
      anchor: 'コントローラー',
    })
  })

  test('finds an identifier by its camel-case parts', () => {
    expect(find('d1 database', 'en')[0]).toEqual({ slug: 'cloudflare', anchor: 'database-d1' })
  })

  test('does not let one title match sweep the results with a single doc', () => {
    // The title is matchable on every section but weighted on the first, so a
    // document whose *heading* is about the query outranks the rest of the
    // document whose title merely mentions it.
    const results = find('database', 'en').map((row) => `${row.slug}#${row.anchor}`)

    expect(results[0]).toBe('database#database')
    expect(results.indexOf('health#database-check')).toBeLessThan(
      results.indexOf('database#relations'),
    )
  })

  test('pairs a doc title with a heading from a later section', () => {
    // The title is weighted on the first section only, so it has to be
    // *matchable* on every one — FTS5 ANDs terms within a row, and without
    // the second title column this query has nowhere to land.
    expect(find('コントローラー 型安全', 'ja').map((row) => row.anchor)).toContain('型安全')
  })

  test('finds a one-character CJK query through the unigram column', () => {
    // 「型」never appears as a bigram — 「型安全」tokenizes to 「型安 安全」—
    // so this only works because every CJK character is also stored alone.
    expect(find('型', 'ja').map((row) => row.anchor).sort()).toEqual([
      'ルーティング',
      '型安全',
    ])
  })

  test('does not leak results across locales', () => {
    expect(find('コントローラー', 'en')).toEqual([])
  })

  test('treats FTS5 syntax in a query as literal text', () => {
    // Each of these is a syntax error if it reaches the MATCH parser unquoted.
    for (const hostile of ['a OR b', 'NEAR(auth, guard)', 'body:*', '"', '^foo', 'a - b']) {
      expect(() => find(hostile, 'en')).not.toThrow()
    }
  })
})

describe('bm25 weights', () => {
  test('the unigram vector orders rows, and the token vector cannot', () => {
    const match = buildSearchMatch('型', 'ja')
    const ranks = (weights: readonly number[]): number[] =>
      (
        db
          .query(
            `SELECT bm25("${search}", ${weights.join(', ')}) AS rank
             FROM "${search}" WHERE "${search}" MATCH ?`,
          )
          .all(match?.match ?? '') as { rank: number }[]
      ).map((row) => row.rank)

    // Weighting the matched column 0.0 does not merely flatten the ordering,
    // it removes it: every row comes back with the same score.
    expect(new Set(ranks(BM25_WEIGHTS.tokens)).size).toBe(1)
    expect(new Set(ranks(BM25_WEIGHTS.unigram)).size).toBeGreaterThan(1)
  })
})

describe('SQL string escaping', () => {
  /**
   * What drizzle would put in the statement for this value, had it built one.
   *
   * `inlineParams()` is public; reaching the dialect that renders it is not,
   * which is why the generator does its own quoting rather than depending on
   * this. Using it here is the point: it turns three lines of hand-written
   * `replace` into something checked against a parser-aware implementation,
   * and if the internal moves, only this test breaks.
   */
  const inlineAsDrizzleWould = (() => {
    const handle = drizzle({ client: new Database(':memory:') }) as unknown as {
      dialect: { sqlToQuery(query: unknown): { sql: string } }
    }
    return (value: string): string => handle.dialect.sqlToQuery(sql`${value}`.inlineParams()).sql
  })()

  /**
   * Every hostile fragment on its own and in every ordered pair — a few
   * hundred values, which is more of the space than any fixture spells out.
   * The corpus is TypeScript documentation, so quotes, semicolons, backslashes
   * and template syntax are ordinary content rather than edge cases.
   */
  const FRAGMENTS = [
    "it's",
    "''",
    '"',
    '`',
    ';',
    '--',
    '/*',
    '\\',
    '${x}',
    '\n',
    '\t',
    ')',
    'x',
    '認証',
    '🎉',
  ]
  const VALUES = FRAGMENTS.flatMap((a) => FRAGMENTS.map((b) => `${a}${b}`)).concat(FRAGMENTS)

  test('quotes every value the way drizzle would', () => {
    const rows = VALUES.map((value, index) => ({
      title: `t${index}`,
      html: `<h1 id="h${index}">H</h1><p>${value.replace(/</gu, '&lt;')}</p>`,
    }))
    const corpus: DocsByLocale = {
      en: { guides: Object.fromEntries(rows.map((doc, index) => [`doc-${index}`, doc])) },
    }

    const collected = collectRows(corpus)
    const generated = renderIndexSql(collected, 'escapecheck')

    expect(collected.length).toBeGreaterThanOrEqual(VALUES.length)
    for (const row of collected) {
      for (const value of [row.docTitle, row.heading, row.body, row.bodyTokens]) {
        expect(generated).toContain(inlineAsDrizzleWould(value))
      }
    }
  })

  test('drops a NUL that drizzle would pass through', () => {
    // The one deliberate difference, and it is upstream of quoting: a NUL ends
    // the literal inside SQLite's parser instead of failing, so it cannot
    // reach the file — from the body, from a heading, or from an anchor a
    // hand-written `id` put there.
    const value = 'a' + '\u0000' + 'b'
    expect(inlineAsDrizzleWould(value)).toContain('\u0000')

    const generated = renderIndexSql(
      collectRows({
        en: {
          guides: {
            doc: {
              title: `T${value}`,
              html: `<h1 id="h${value}">H${value}</h1><p>${value}</p>`,
            },
          },
        },
      }),
      'nulcheck',
    )

    expect(generated).not.toContain('\u0000')
    expect(generated).toContain('doc_sections_nulcheck')
  })
})
