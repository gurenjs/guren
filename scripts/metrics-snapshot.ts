// Weekly adoption-metrics snapshot: npm downloads for every public workspace
// package plus GitHub repository traffic. GitHub's traffic API only retains
// 14 days, so without a periodic snapshot the referrer data around a launch
// is lost for good. Run by .github/workflows/metrics-snapshot.yml, which
// uploads the JSON to a private R2 bucket — the referrer list is admin-only
// data on GitHub and must not land anywhere in this public repository.
//
// Usage: bun scripts/metrics-snapshot.ts [--out path.json]
//   GITHUB_TOKEN   token with push access to the repo (traffic endpoints
//                  need it; without one they are skipped with a warning)

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const REPO = 'gurenjs/guren'

// npm's own package-name grammar. Everything fetched or persisted flows
// through this and the shaping helpers below, so a hostile value in a
// package.json or an API response cannot smuggle URL segments or arbitrary
// payload shapes into the snapshot.
const NPM_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

function asCount(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function asText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

interface NpmDownloads {
  package: string
  downloads: number | null
  start?: string
  end?: string
}

async function publicPackageNames(): Promise<string[]> {
  const packagesDir = resolve(import.meta.dir, '../packages')
  const names: string[] = []
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(
        await readFile(resolve(packagesDir, entry.name, 'package.json'), 'utf8'),
      ) as { name?: string; private?: boolean }
      if (!manifest.name || manifest.private) continue
      if (!NPM_NAME_PATTERN.test(manifest.name)) {
        console.warn(`skipping ${entry.name}: "${manifest.name}" is not a valid npm name`)
        continue
      }
      names.push(manifest.name)
    } catch {
      // A directory without a readable package.json is not a package.
    }
  }
  return names.sort()
}

async function npmLastWeek(name: string): Promise<NpmDownloads> {
  const response = await fetch(`https://api.npmjs.org/downloads/point/last-week/${name}`)
  if (!response.ok) {
    console.warn(`npm downloads for ${name}: HTTP ${response.status}`)
    return { package: name, downloads: null }
  }
  const data = (await response.json()) as Record<string, unknown>
  return {
    package: name,
    downloads: asCount(data.downloads),
    start: asText(data.start, 10),
    end: asText(data.end, 10),
  }
}

async function github(path: string, token: string | undefined): Promise<unknown | null> {
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!response.ok) {
    console.warn(`GitHub ${path}: HTTP ${response.status} (traffic endpoints need push access)`)
    return null
  }
  return response.json()
}

/** Daily views/clones series: {count, uniques, <key>: [{timestamp, count, uniques}]} */
function shapeSeries(raw: unknown, key: 'views' | 'clones') {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const entries = Array.isArray(record[key]) ? (record[key] as unknown[]) : []
  return {
    count: asCount(record.count),
    uniques: asCount(record.uniques),
    days: entries.map((entry) => {
      const point = (entry ?? {}) as Record<string, unknown>
      return {
        timestamp: asText(point.timestamp, 32),
        count: asCount(point.count),
        uniques: asCount(point.uniques),
      }
    }),
  }
}

/** Top-10 referrers/paths: keep only the documented fields, length-capped. */
function shapeRanking(raw: unknown, nameKey: 'referrer' | 'path') {
  if (!Array.isArray(raw)) return null
  return raw.slice(0, 20).map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>
    return {
      [nameKey]: asText(record[nameKey], 300),
      ...(nameKey === 'path' ? { title: asText(record.title, 300) } : {}),
      count: asCount(record.count),
      uniques: asCount(record.uniques),
    }
  })
}

const outFlag = process.argv.indexOf('--out')
const outPath = outFlag === -1 ? 'metrics-snapshot.json' : process.argv[outFlag + 1]
if (!outPath) {
  console.error('--out requires a path')
  process.exit(1)
}

const token = process.env.GITHUB_TOKEN
const packages = await publicPackageNames()

const repoInfo = ((await github('', token)) ?? {}) as Record<string, unknown>

const snapshot = {
  takenAt: new Date().toISOString(),
  npm: {
    // last-week is a rolling window; `start`/`end` in each entry record it.
    downloads: await Promise.all(packages.map(npmLastWeek)),
  },
  github: {
    repo: REPO,
    stars: asCount(repoInfo.stargazers_count),
    forks: asCount(repoInfo.forks_count),
    openIssues: asCount(repoInfo.open_issues_count),
    // Each traffic payload covers the trailing 14 days.
    traffic: {
      views: shapeSeries(await github('/traffic/views', token), 'views'),
      clones: shapeSeries(await github('/traffic/clones', token), 'clones'),
      referrers: shapeRanking(await github('/traffic/popular/referrers', token), 'referrer'),
      paths: shapeRanking(await github('/traffic/popular/paths', token), 'path'),
    },
  },
}

await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`Wrote ${outPath}`)
console.log(
  `npm last-week: ${snapshot.npm.downloads
    .map((entry) => `${entry.package}=${entry.downloads ?? '?'}`)
    .join(', ')}`,
)
