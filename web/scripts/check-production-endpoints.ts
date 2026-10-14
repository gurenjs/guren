/**
 * After a deploy, the development endpoints must answer 404 on the live site
 * and the home page 200 (RFC 0032 M5). `/_guren/docs` is left out: guren.dev
 * serves a prerendered docs-viewer snapshot there on purpose. GET only, since a
 * POST meets CSRF verification before routing and reads 403 either way.
 *   bun scripts/check-production-endpoints.ts [origin]
 */
const origin = process.argv[2] ?? 'https://guren.dev'

const EXPECTED: ReadonlyArray<[path: string, status: number]> = [
  ['/', 200],
  ['/_guren', 404],
  ['/_guren/graph.json', 404],
  ['/_guren/runtime/errors?limit=1', 404],
  ['/_guren/mcp', 404],
]

let ok = true
for (const [path, expected] of EXPECTED) {
  let status: number | string
  try {
    status = (await fetch(new URL(path, origin), { redirect: 'manual', signal: AbortSignal.timeout(10_000) })).status
  } catch (error) {
    status = error instanceof Error ? error.message : String(error)
  }
  const pass = status === expected
  if (!pass) ok = false
  console.log(`${pass ? 'ok  ' : 'FAIL'} GET ${path}: ${status} (expected ${expected})`)
}
process.exit(ok ? 0 : 1)
