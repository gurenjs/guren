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
      if (manifest.name && !manifest.private) names.push(manifest.name)
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
  const data = (await response.json()) as { downloads: number; start: string; end: string }
  return { package: name, downloads: data.downloads, start: data.start, end: data.end }
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

const outFlag = process.argv.indexOf('--out')
const outPath = outFlag === -1 ? 'metrics-snapshot.json' : process.argv[outFlag + 1]
if (!outPath) {
  console.error('--out requires a path')
  process.exit(1)
}

const token = process.env.GITHUB_TOKEN
const packages = await publicPackageNames()

const repoInfo = (await github('', token)) as {
  stargazers_count?: number
  forks_count?: number
  open_issues_count?: number
} | null

const snapshot = {
  takenAt: new Date().toISOString(),
  npm: {
    // last-week is a rolling window; `start`/`end` in each entry record it.
    downloads: await Promise.all(packages.map(npmLastWeek)),
  },
  github: {
    repo: REPO,
    stars: repoInfo?.stargazers_count ?? null,
    forks: repoInfo?.forks_count ?? null,
    openIssues: repoInfo?.open_issues_count ?? null,
    // Each traffic payload covers the trailing 14 days.
    traffic: {
      views: await github('/traffic/views', token),
      clones: await github('/traffic/clones', token),
      referrers: await github('/traffic/popular/referrers', token),
      paths: await github('/traffic/popular/paths', token),
    },
  },
}

await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`Wrote ${outPath}`)
console.log(
  `npm last-week: ${snapshot.npm.downloads
    .map((d) => `${d.package}=${d.downloads ?? '?'}`)
    .join(', ')}`,
)
