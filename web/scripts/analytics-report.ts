// Weekly read-only report over the site's Workers Analytics Engine dataset.
// The token needs the "Account Analytics: Read" permission. Tag outbound links
// with `?ref=<channel>` (a lowercase slug) so their landings show up by channel.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun scripts/analytics-report.ts [--days 7]

const DATASET = 'guren_dev_analytics'

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const apiToken = process.env.CLOUDFLARE_API_TOKEN

if (!accountId || !apiToken) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account Analytics: Read).')
  process.exit(1)
}

const daysFlag = process.argv.indexOf('--days')
const days = daysFlag === -1 ? 7 : Number(process.argv[daysFlag + 1] ?? 7)
// Analytics Engine retains roughly three months, so cap the window there.
if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
  console.error('--days must be an integer between 1 and 90')
  process.exit(1)
}

// Data point layout: see web/app/Http/Middleware/site-analytics.ts.
const WINDOW = `timestamp > NOW() - INTERVAL '${days}' DAY`

// A browser-like user agent is classed `human`, so scanners land there: in the
// 30 days to 2026-09-11, 63% of `human` requests were 404s. A reader is a
// successful GET from a client that sends Accept-Language.
const READER = `blob3 = 'human' AND blob7 = 'GET' AND double1 >= 200 AND double1 < 300 AND blob5 != ''`
// `/` is fetched by clients that never open a page, so it is not reading. Older
// points class the feed as `blog`, and Analytics Engine keeps them ~90 days.
const READING = `blob2 IN ('docs', 'blog', 'markdown') AND blob1 != '/blog/rss.xml'`
// www.guren.dev 301s to the apex, so no page there can send this referrer; only
// clients that forge it do.
const FORGED_REFERRER = 'www.guren.dev'
const AGENT_OK = `blob3 = 'ai-agent' AND double1 >= 200 AND double1 < 300`

const queries: Array<{ title: string; sql: string }> = [
  {
    title: 'Requests by visitor class',
    sql: `SELECT blob3 AS visitor, SUM(_sample_interval) AS requests,
                 SUM(IF(double1 >= 400, _sample_interval, 0)) AS errors
          FROM ${DATASET} WHERE ${WINDOW}
          GROUP BY visitor ORDER BY requests DESC`,
  },
  {
    title: 'Readers by content class',
    sql: `SELECT blob2 AS content, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND ${READER} AND ${READING}
          GROUP BY content ORDER BY requests DESC`,
  },
  {
    title: 'Top pages (readers)',
    sql: `SELECT blob1 AS path, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND ${READER} AND ${READING}
          GROUP BY path ORDER BY requests DESC LIMIT 15`,
  },
  {
    title: 'Top referrers (readers)',
    sql: `SELECT blob4 AS referrer, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND ${READER}
            AND blob4 != '' AND blob4 != '${FORGED_REFERRER}'
          GROUP BY referrer ORDER BY requests DESC LIMIT 15`,
  },
  {
    title: 'Landings by ref tag (readers)',
    sql: `SELECT blob10 AS ref, blob1 AS path, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND ${READER} AND blob10 != ''
          GROUP BY ref, path ORDER BY requests DESC LIMIT 20`,
  },
  {
    title: 'Languages (readers)',
    sql: `SELECT blob5 AS language, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND ${READER} AND ${READING}
          GROUP BY language ORDER BY requests DESC LIMIT 10`,
  },
  {
    title: 'Feed polls',
    sql: `SELECT blob3 AS visitor, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND blob1 = '/blog/rss.xml'
            AND double1 >= 200 AND double1 < 300
          GROUP BY visitor ORDER BY requests DESC`,
  },
  {
    title: 'Agent traffic: markdown mirrors and llms.txt',
    sql: `SELECT blob2 AS content, blob3 AS visitor, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND blob2 IN ('markdown', 'llms')
            AND double1 >= 200 AND double1 < 300
          GROUP BY content, visitor ORDER BY requests DESC LIMIT 15`,
  },
  {
    title: 'Top docs pages fetched by AI agents',
    sql: `SELECT blob1 AS path, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND ${AGENT_OK} AND blob2 IN ('docs', 'markdown', 'llms')
          GROUP BY path ORDER BY requests DESC LIMIT 15`,
  },
  {
    // A token whose requests are mostly errors is an alternative scanners match.
    title: 'AI agent matches by user-agent token',
    sql: `SELECT blob9 AS token, SUM(_sample_interval) AS requests,
                 SUM(IF(double1 >= 400, _sample_interval, 0)) AS errors
          FROM ${DATASET} WHERE ${WINDOW} AND blob3 = 'ai-agent'
          GROUP BY token ORDER BY requests DESC LIMIT 20`,
  },
]

async function runQuery(sql: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: sql,
    },
  )
  if (!response.ok) {
    throw new Error(`SQL API ${response.status}: ${await response.text()}`)
  }
  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> }
  return payload.data ?? []
}

console.log(`# guren.dev analytics — last ${days} day(s)\n`)
for (const { title, sql } of queries) {
  console.log(`## ${title}`)
  const rows = await runQuery(sql)
  if (rows.length === 0) {
    console.log('(no data)\n')
    continue
  }
  console.table(rows)
  console.log('')
}
