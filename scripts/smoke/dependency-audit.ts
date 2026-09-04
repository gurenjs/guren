/**
 * Dependency vulnerability gate over `bun audit --json`.
 *
 * Fails on any advisory matching an installed package, unless listed in
 * IGNORED_ADVISORIES with a reason and what unblocks its removal. A stale entry
 * fails too, so the list cannot rot.
 *
 * Exit codes: 0 clean, 1 active advisories / stale or invalid ignores, 2 scan
 * unavailable (registry failure or unrecognized output) — an unavailable scan is
 * a failure, not a silent pass.
 *
 * `guren audit`'s app-facing scan (packages/cli/src/audit-deps.ts) implements the
 * same `bun audit` contract; an output-shape change needs both updated.
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
      'Fixed in 0.28.1. The only holder is vite 8\'s optional esbuild peer ' +
      '(`bun pm why esbuild`), resolved at 0.27.7 in the lockfile. Nothing published ' +
      'or scaffolded runs the esbuild dev server.',
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

// `bun audit` exits 0 or 1 with valid JSON either way; anything else is an
// execution/registry failure. A proxy can answer with JSON that merely *parses*
// (an error object, not the package→advisories map), so the shape is validated.
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
