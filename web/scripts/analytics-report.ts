// Query the site's Workers Analytics Engine dataset over the SQL API and
// print a small weekly report. Reads, not writes — safe to run any time.
//
// Usage:
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... bun scripts/analytics-report.ts [--days 7]
//
// The token needs the "Account Analytics: Read" permission.

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

const queries: Array<{ title: string; sql: string }> = [
  {
    title: 'Requests by visitor class',
    sql: `SELECT blob3 AS visitor, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW}
          GROUP BY visitor ORDER BY requests DESC`,
  },
  {
    title: 'Top pages (humans)',
    sql: `SELECT blob1 AS path, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND blob3 = 'human' AND blob7 = 'GET'
          GROUP BY path ORDER BY requests DESC LIMIT 15`,
  },
  {
    title: 'Top referrers (humans)',
    sql: `SELECT blob4 AS referrer, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND blob3 = 'human' AND blob4 != ''
          GROUP BY referrer ORDER BY requests DESC LIMIT 15`,
  },
  {
    title: 'Agent traffic: markdown mirrors and llms.txt',
    sql: `SELECT blob2 AS content, blob3 AS visitor, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND blob2 IN ('markdown', 'llms')
          GROUP BY content, visitor ORDER BY requests DESC LIMIT 15`,
  },
  {
    title: 'Top docs pages fetched by AI agents',
    sql: `SELECT blob1 AS path, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND blob3 = 'ai-agent'
          GROUP BY path ORDER BY requests DESC LIMIT 15`,
  },
  {
    title: 'Languages (humans)',
    sql: `SELECT blob5 AS language, SUM(_sample_interval) AS requests
          FROM ${DATASET} WHERE ${WINDOW} AND blob3 = 'human' AND blob5 != ''
          GROUP BY language ORDER BY requests DESC LIMIT 10`,
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
