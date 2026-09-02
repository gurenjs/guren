import { describe, expect, it } from 'vitest'

import {
  collectRows,
  computeBuildId,
  renderIndexSql,
  MAX_STATEMENT_BYTES,
  type DocsByLocale,
} from '../../app/Services/search-index-build.js'
import { MAX_SECTION_BODY } from '../../app/Services/search-sections.js'

function corpus(overrides: Partial<Record<string, string>> = {}): DocsByLocale {
  return {
    en: {
      guides: {
        routing: {
          title: 'Routing',
          html: `<h1 id="routing">Routing</h1><p>${overrides.body ?? 'Define routes.'}</p><h2 id="groups">Groups</h2><p>Nest them.</p>`,
        },
      },
    },
    ja: {
      guides: {
        routing: {
          title: 'ルーティング',
          html: '<h1 id="ルーティング">ルーティング</h1><p>ルートを定義する。</p>',
        },
      },
    },
  }
}

describe('collectRows', () => {
  it('numbers rows from one, in traversal order', () => {
    const rows = collectRows(corpus())

    expect(rows.map((row) => row.id)).toEqual([1, 2, 3])
    expect(rows.map((row) => `${row.locale}#${row.anchor}`)).toEqual([
      'en#routing',
      'en#groups',
      'ja#ルーティング',
    ])
  })

  it('carries the doc title onto every section for display', () => {
    expect(collectRows(corpus()).map((row) => row.docTitle)).toEqual([
      'Routing',
      'Routing',
      'ルーティング',
    ])
  })

  it('weights the doc title on the first section and matches it on all of them', () => {
    // Two columns, because matching and ranking want opposite things. Weighted
    // everywhere, one title hit swept the list with sections of a single doc;
    // present on the first section only, `ルーティング ミドルウェア` could not
    // match at all, since FTS5 ANDs terms within a row.
    const rows = collectRows(corpus())

    expect(rows.map((row) => row.docTitleLead)).toEqual([
      'routing',
      '',
      'ルー ーテ ティ ィン ング',
    ])
    expect(rows.map((row) => row.docTitleTokens)).toEqual([
      'routing',
      'routing',
      'ルー ーテ ティ ィン ング',
    ])
  })

  it('hashes the text it stores, not the text it was given', () => {
    // A NUL truncates a SQL literal inside the parser, so it is dropped before
    // storage. Hashing it anyway would give two corpora that generate
    // byte-identical SQL different ids, and reindex production for nothing.
    // One NUL against two: they tokenize identically (a NUL separates, like
    // any other non-letter) and they store identically once it is dropped, so
    // the SQL is byte for byte the same and the id has to be too.
    const one = collectRows(corpus({ body: 'a\u0000b' }))
    const two = collectRows(corpus({ body: 'a\u0000\u0000b' }))

    expect(renderIndexSql(one, 'x')).toBe(renderIndexSql(two, 'x'))
    expect(computeBuildId(one)).toBe(computeBuildId(two))
  })

  it('collects unigrams from the title, heading, and body together', () => {
    const japanese = collectRows(corpus()).at(-1)
    expect(japanese?.unigrams).toContain('ル')
    expect(japanese?.bodyTokens).toBe('ルー ート トを を定 定義 義す する')
  })
})

describe('computeBuildId', () => {
  it('is stable across calls', () => {
    expect(computeBuildId(collectRows(corpus()))).toBe(computeBuildId(collectRows(corpus())))
  })

  it('does not depend on key insertion order', () => {
    // The deploy gate compares this id; a traversal that followed insertion
    // order would report a content change on every unrelated docs edit.
    const reordered: DocsByLocale = { ja: corpus().ja, en: corpus().en }
    expect(computeBuildId(collectRows(reordered))).toBe(computeBuildId(collectRows(corpus())))
  })

  it('moves when a single character of the corpus changes', () => {
    expect(computeBuildId(collectRows(corpus({ body: 'Define route.' })))).not.toBe(
      computeBuildId(collectRows(corpus())),
    )
  })

  it('is the same value this corpus has always produced', () => {
    // A golden value, because the property that matters is a negative one:
    // if a clock, a git sha or a build counter ever reached the id, a
    // docs-unchanged deploy would skip reindexing and then bake a table name
    // nobody created. Nothing weaker than a fixed expectation catches that.
    // Update it deliberately, together with INDEX_FORMAT, when the stored
    // shape changes.
    expect(computeBuildId(collectRows(corpus()))).toBe('2b92f12c25318af8')
  })
})

describe('renderIndexSql', () => {
  const sql = renderIndexSql(collectRows(corpus()), 'abc123')

  it('names both tables after the build', () => {
    expect(sql).toContain('CREATE TABLE "doc_sections_abc123"')
    expect(sql).toContain('CREATE VIRTUAL TABLE "doc_search_abc123"')
  })

  it('writes the FTS rowid explicitly', () => {
    // It is the only key a contentless table has, and the join back to
    // doc_sections depends on it lining up with the section id.
    expect(sql).toContain('INSERT INTO "doc_search_abc123" (rowid,')
  })

  it('does not drop the previous build', () => {
    // Retiring the old tables belongs after a successful deploy: doing it here
    // would leave the live Worker pointing at nothing if the deploy failed.
    expect(sql.match(/DROP TABLE IF EXISTS/gu)).toHaveLength(2)
    expect(sql).not.toContain('doc_sections_%')
  })

  it('records the build id and keeps the one it replaces', () => {
    // The replaced build has to stay nameable: a rollback activates an
    // earlier Worker and does not bring D1 back with it.
    expect(sql).toContain(`VALUES (1, 'abc123', NULL, unixepoch())`)
    expect(sql).toContain('previous_build_id = "search_index_state".build_id')
  })

  it('doubles quotes in content', () => {
    const quoted = renderIndexSql(
      collectRows({
        en: {
          guides: {
            a: { title: 'A', html: `<h1 id="a">A</h1><p>console.log('x; y')</p>` },
          },
        },
      }),
      'abc123',
    )
    expect(quoted).toContain(`'console.log(''x; y'')'`)
  })

  it('batches rows into statements that stay under the D1 budget', () => {
    const rows = collectRows(corpus({ body: 'word '.repeat(MAX_SECTION_BODY * 10) }))
    const generated = renderIndexSql(rows, 'abc123')

    // Enough content that one statement could not hold it — otherwise the
    // batching this asserts would never run.
    expect(generated.match(/INSERT INTO "doc_sections_abc123"/gu)?.length).toBeGreaterThan(1)
    for (const statement of generated.split(/;\n/u)) {
      expect(Buffer.byteLength(statement, 'utf8')).toBeLessThanOrEqual(MAX_STATEMENT_BYTES)
    }
  })
})
