/**
 * Dependency vulnerability gate over `bun audit --json`.
 *
 * Fails when any advisory matches an installed package, except advisories
 * listed in IGNORED_ADVISORIES below. Every ignore entry must say why the
 * advisory is acceptable and what unblocks its removal. A stale entry (one
 * that no longer matches anything) also fails, so the list cannot rot.
 *
 * Exit codes: 0 clean (ignores may apply), 1 active advisories or stale
 * ignores, 2 scan unavailable (network/registry failure) — CI treats an
 * unavailable scan as a failure rather than a silent pass.
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

const ghsaPattern = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i

const proc = Bun.spawn([process.execPath, 'audit', '--json'], {
  stdout: 'pipe',
  stderr: 'pipe',
})
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
])
await proc.exited

let report: Record<string, Advisory[]>
try {
  report = JSON.parse(stdout) as Record<string, Advisory[]>
} catch {
  console.error('dependency audit: could not scan (no JSON from `bun audit`).')
  if (stderr.trim()) console.error(stderr.trim())
  process.exit(2)
}

const ignoredIds = new Set(IGNORED_ADVISORIES.map((entry) => entry.id.toUpperCase()))
const matchedIgnores = new Set<string>()
const active: Array<{ pkg: string; advisory: Advisory }> = []

for (const [pkg, advisories] of Object.entries(report)) {
  for (const advisory of advisories) {
    const ghsa = advisory.url.match(ghsaPattern)?.[0]?.toUpperCase()
    if (ghsa && ignoredIds.has(ghsa)) {
      matchedIgnores.add(ghsa)
    } else {
      active.push({ pkg, advisory })
    }
  }
}

for (const entry of IGNORED_ADVISORIES) {
  if (matchedIgnores.has(entry.id.toUpperCase())) {
    console.log(`[ignored] ${entry.id}: ${entry.reason}`)
  }
}

const stale = IGNORED_ADVISORIES.filter((entry) => !matchedIgnores.has(entry.id.toUpperCase()))
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
