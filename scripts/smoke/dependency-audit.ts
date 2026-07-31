/**
 * Dependency vulnerability gate over `bun audit --json`.
 *
 * Fails when any advisory matches an installed package, except advisories
 * listed in IGNORED_ADVISORIES below. Every ignore entry must say why the
 * advisory is acceptable and what unblocks its removal. A stale entry (one
 * that no longer matches anything) also fails, so the list cannot rot.
 *
 * Exit codes: 0 clean (ignores may apply), 1 active advisories, stale
 * ignores, or an invalid ignore list, 2 scan unavailable (registry
 * failure or unrecognized `bun audit` output) — CI treats an unavailable
 * scan as a failure rather than a silent pass.
 */

interface Advisory {
  url: string
  title: string
  severity: string
  vulnerable_versions: string
}

interface IgnoredAdvisory {
  /** GHSA id as it appears in the advisory URL. */
  id: string
  reason: string
}

const IGNORED_ADVISORIES: IgnoredAdvisory[] = [
  {
    id: 'GHSA-g7r4-m6w7-qqqr',
    reason:
      'esbuild 0.27.x arbitrary file read: Windows-only, dev-server-only, low severity. ' +
      'Fixed in 0.28.1, but vite/tsup/drizzle-kit all pin ^0.27 so the fix is unreachable ' +
      'until they move. Nothing published or scaffolded runs the esbuild dev server.',
  },
]

const ignoredIds = new Set<string>()
for (const entry of IGNORED_ADVISORIES) {
  const id = entry.id.toUpperCase()
  if (!/^GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(id) || !entry.reason.trim()) {
    console.error(`invalid ignore entry '${entry.id}': needs a GHSA id and a non-empty reason.`)
    process.exit(1)
  }
  if (ignoredIds.has(id)) {
    console.error(`duplicate ignore entry '${entry.id}'.`)
    process.exit(1)
  }
  ignoredIds.add(id)
}

const proc = Bun.spawn([process.execPath, 'audit', '--json'], {
  stdout: 'pipe',
  stderr: 'pipe',
})
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])

function scanUnavailable(why: string): never {
  console.error(`dependency audit: could not scan (${why}).`)
  const details = stderr.trim()
  if (details) console.error(details)
  process.exit(2)
}

// `bun audit` exits 0 (clean) or 1 (advisories found), valid JSON either
// way; anything else is an execution/registry failure. A proxy can also
// answer with JSON that merely *parses* — an error object instead of the
// package→advisories map — so the shape is validated, not assumed.
if (exitCode > 1) scanUnavailable(`bun audit exited with code ${exitCode}`)

let report: Record<string, Advisory[]>
try {
  report = JSON.parse(stdout) as Record<string, Advisory[]>
} catch {
  scanUnavailable('no JSON from bun audit')
}
if (typeof report !== 'object' || report === null || Array.isArray(report)) {
  scanUnavailable('unrecognized bun audit output shape')
}

const matchedIgnores = new Set<string>()
const active: Array<{ pkg: string; advisory: Advisory }> = []

for (const [pkg, advisories] of Object.entries(report)) {
  if (!Array.isArray(advisories)) scanUnavailable('unrecognized bun audit output shape')
  for (const advisory of advisories) {
    if (typeof advisory?.url !== 'string') scanUnavailable('unrecognized bun audit output shape')
    const ghsa = advisory.url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i)?.[0].toUpperCase()
    if (ghsa && ignoredIds.has(ghsa)) {
      matchedIgnores.add(ghsa)
    } else {
      active.push({ pkg, advisory })
    }
  }
}

const stale: IgnoredAdvisory[] = []
for (const entry of IGNORED_ADVISORIES) {
  if (matchedIgnores.has(entry.id.toUpperCase())) {
    console.log(`[ignored] ${entry.id}: ${entry.reason}`)
  } else {
    stale.push(entry)
  }
}
for (const entry of stale) {
  console.error(
    `[stale ignore] ${entry.id} no longer matches any installed package — remove it from ${import.meta.path}.`,
  )
}

for (const { pkg, advisory } of active) {
  console.error(`[${advisory.severity}] ${pkg} ${advisory.vulnerable_versions}: ${advisory.title} (${advisory.url})`)
}

if (active.length > 0 || stale.length > 0) {
  console.error(
    `dependency audit failed: ${active.length} active advisories, ${stale.length} stale ignore entries.`,
  )
  process.exit(1)
}

console.log(`dependency audit passed (${matchedIgnores.size} ignored advisories).`)
