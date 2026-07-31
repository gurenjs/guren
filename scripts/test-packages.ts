// Runs the Bun test suites of every workspace package under packages/.
//
// The package list is derived from each package.json rather than
// hand-maintained: any package whose `test` script uses Bun's runner is picked
// up automatically, so adding a package (a plugin, for example) needs no change
// here or in the root package.json scripts.
//
// Packages on a different runner (@guren/testing uses vitest) are skipped —
// they have their own root script.
//
//   bun run ./scripts/test-packages.ts                   # test everything
//   bun run ./scripts/test-packages.ts --list            # print the packages only
//   bun run ./scripts/test-packages.ts cli plugin-cloudflare
//   bun run ./scripts/test-packages.ts -- -t "rate limit"  # forward flags to bun test
//
// Positional arguments select packages by directory name or package name.
// Everything after a bare `--` is forwarded to `bun test` verbatim.

import { collectPackages, parseArgs, repoRoot, selectPackages } from './workspace-packages.ts'

// Packages on a runner other than Bun's own (@guren/testing uses vitest) keep
// their own root script instead of joining this one. An explicit list survives
// a `test` script being reworded — a regex sniffing the script string would not.
const nonBunTestPackages = new Set(['@guren/testing'])

const { flags, positionals: selectors, forwarded } = parseArgs(
  process.argv.slice(2),
  ['list'],
)
const listOnly = flags.list

const bunTestPackages = (await collectPackages()).filter(
  (pkg) => pkg.scripts.test && !nonBunTestPackages.has(pkg.name),
)
const targets = selectPackages(bunTestPackages, selectors)

if (listOnly) {
  for (const pkg of targets) console.log(pkg.name)
  process.exit(0)
}

if (targets.length === 0) {
  console.error('[test] no packages with a `bun test` script were found')
  process.exit(1)
}

// A single root-cwd run ignores per-package bunfig.toml, so each package's
// `[test] root` (create-app uses it to keep the *.test.ts files its
// templates ship for scaffolded apps out of the monorepo suite) is resolved
// here and passed as the package's path filter instead. One invocation, so
// forwarded flags like `-t <pattern>` keep matching across packages rather
// than failing in every package the pattern misses.
async function testPathFor(pkg: { dir: string; relativeDir: string }): Promise<string> {
  try {
    const bunfig = await Bun.file(`${pkg.dir}/bunfig.toml`).text()
    const root = bunfig.match(/^\s*root\s*=\s*"([^"]+)"/m)?.[1]
    if (root) return `${pkg.relativeDir}/${root}`
  } catch {
    // no bunfig — the package directory itself is the test root
  }
  return pkg.relativeDir
}

const testArgs = [
  'test',
  '--isolate',
  ...forwarded,
  ...(await Promise.all(targets.map(testPathFor))),
]

console.log(`[test] ${targets.map((pkg) => pkg.name).join(', ')}`)

const proc = Bun.spawn([process.execPath, ...testArgs], {
  cwd: repoRoot,
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
