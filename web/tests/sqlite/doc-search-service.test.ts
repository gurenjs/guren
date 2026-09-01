/**
 * DocSearchService against a real FTS5 engine, through the same generated SQL
 * a deploy applies. Runs under `bun test` for the reason
 * `tests/sqlite/search-index.test.ts` explains: Node's bundled SQLite has no
 * FTS5 module, so vitest cannot host any of this.
 */
import { Database } from 'bun:sqlite'

import { drizzle } from 'drizzle-orm/bun-sqlite'

import { beforeAll, describe, expect, test } from 'bun:test'

import {
  DocSearchService,
  SearchIndexUnavailableError,
} from '../../app/Services/DocSearchService.js'
import {
  collectRows,
  computeBuildId,
  renderIndexSql,
  searchTableName,
  sectionsTableName,
  type DocsByLocale,
} from '../../app/Services/search-index-build.js'
import { applyMigrations } from './migrations.js'

const docs: DocsByLocale = {
  en: {
    guides: {
      // Long enough that section splitting stores it as many rows under one
      // anchor — more than any fixed over-fetch would leave room for.
      operations: {
        title: 'Operations',
        html: `<h1 id="operations">Operations</h1><p>${'Rotate the paginated ledger. '.repeat(4000)}</p>`,
      },
      // Nine more documents mentioning the same word once, so a crowding-out
      // failure is visible as their absence rather than as a reordering.
      ...Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `note-${index}`,
          {
            title: `Note ${index}`,
            html: `<h1 id="note-${index}">Note ${index}</h1><p>A paginated note.</p>`,
          },
        ]),
      ),
      overview: {
        title: 'Guide overview',
        html: '<h1 id="overview">Overview</h1><p>Guren at a glance, step by step.</p>',
      },
      cloudflare: {
        title: 'Cloudflare',
        html:
          '<h1 id="cloudflare">Cloudflare</h1><p>Deploy the app to Workers.</p>' +
          '<h2 id="database-d1">Database (D1)</h2>' +
          '<p>Call <code>createD1Database</code> with the binding from wrangler.jsonc.</p>',
      },
    },
    tutorials: {
      overview: {
        title: 'Tutorial overview',
        html: '<h1 id="overview">Overview</h1><p>Build a blog with Guren, step by step.</p>',
      },
    },
  },
  ja: {
    guides: {
      controllers: {
        title: 'コントローラー',
        html:
          '<h1 id="コントローラー">コントローラー</h1>' +
          '<p>コントローラーはリクエストを受け取り、レスポンスを返す。</p>' +
          '<h2 id="型安全">型安全</h2><p>型安全なリクエストパースを行う。</p>',
      },
    },
  },
}

const rows = collectRows(docs)
const buildId = computeBuildId(rows)
const build = {
  indexed: true,
  buildId,
  sectionsTable: sectionsTableName(buildId),
  searchTable: searchTableName(buildId),
}

let service: DocSearchService

beforeAll(() => {
  const client = new Database(':memory:')
  applyMigrations(client)
  client.exec(renderIndexSql(rows, buildId))
  const db = drizzle({ client })
  service = new DocSearchService(async () => db, build)
})

describe('DocSearchService', () => {
  test('finds a Japanese heading and links to its anchor', async () => {
    const [first] = await service.search('コントローラー', 'ja')

    expect(first).toMatchObject({
      category: 'guides',
      slug: 'controllers',
      docTitle: 'コントローラー',
      url: `/docs/ja/guides/controllers#${encodeURIComponent('コントローラー')}`,
    })
  })

  test('finds an identifier through its camel-case parts', async () => {
    const results = await service.search('d1 database', 'en')

    expect(results[0]).toMatchObject({ slug: 'cloudflare', anchor: 'database-d1' })
    expect(results[0].snippet).toContain('createD1Database')
  })

  test('finds a one-character CJK query', async () => {
    const results = await service.search('型', 'ja')

    expect(results.map((result) => result.anchor)).toContain('型安全')
  })

  test('links English results to the English path', async () => {
    const [first] = await service.search('workers', 'en')

    expect(first.url).toBe('/docs/guides/cloudflare#cloudflare')
  })

  test('shows a split section once, at its best-ranked row', async () => {
    // A body over the row cap becomes several rows sharing one anchor. Without
    // deduplication the same heading fills the whole result list.
    const results = await service.search('ledger', 'en')

    expect(results.filter((result) => result.anchor === 'operations')).toHaveLength(1)
  })

  test('scopes results to the requested locale', async () => {
    // The filter lives inside MATCH rather than in a WHERE after it: filtering
    // afterwards makes FTS5 read every matching row before discarding half.
    expect(await service.search('コントローラー', 'en')).toEqual([])
    expect(await service.search('workers', 'ja')).toEqual([])
  })

  test('returns nothing for a query with no searchable characters', async () => {
    expect(await service.search('***', 'en')).toEqual([])
  })

  test('does not turn FTS5 syntax into a query error', async () => {
    for (const hostile of ['a OR b', 'NEAR(x, y)', 'body:*', '"']) {
      expect(await service.search(hostile, 'en')).toBeArray()
    }
  })

  test('keeps two categories that share a slug and an anchor apart', async () => {
    // `guides/overview` and `tutorials/overview` both exist in the real docs,
    // and their h1 anchors are identical — a key without the category shows
    // one of them and silently drops the other.
    const results = await service.search('step by step', 'en')

    expect(results.map((result) => result.category).sort()).toEqual(['guides', 'tutorials'])
  })

  test('returns as many distinct sections as the limit allows', async () => {
    expect(await service.search('step by step', 'en', 1)).toHaveLength(1)
    expect(await service.search('step by step', 'en', 2)).toHaveLength(2)
  })

  test('is not crowded out by one section with many chunks', async () => {
    // Deduplicating after a fixed over-fetch only works while no section has
    // more chunks than the multiple. `paginated` appears in one very long
    // section and in nine short docs; over-fetching 2x the limit returned the
    // long section alone and dropped the other nine.
    const results = await service.search('paginated', 'en', 5)

    expect(results.map((result) => result.slug)).toContain('operations')
    expect(new Set(results.map((result) => result.slug)).size).toBe(5)
  })

  test('refuses to answer when the index was never built', async () => {
    // A checkout that has not run the build carries a stub module. Returning
    // an empty list there would present a broken deploy as "nothing matched".
    const unbuilt = new DocSearchService(async () => {
      throw new Error('should not reach the database')
    }, { indexed: false, buildId: '', sectionsTable: '', searchTable: '' })

    await expect(unbuilt.search('anything', 'en')).rejects.toBeInstanceOf(
      SearchIndexUnavailableError,
    )
  })
})
