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
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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

const migrationsDir = join(import.meta.dir, '../../db/migrations')

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
  for (const entry of readdirSync(migrationsDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort()) {
    db.exec(readFileSync(join(migrationsDir, entry, 'migration.sql'), 'utf8'))
  }
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
