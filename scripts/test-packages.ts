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

console.log(`[test] ${targets.map((pkg) => pkg.name).join(', ')}`)

// One `bun test` per package, from the package's own directory: a single
// root-cwd run ignores per-package bunfig.toml, and create-app relies on
// its `[test] root` to keep the *.test.ts files its templates ship for
// scaffolded apps out of the monorepo's own suite.
let failed = false
for (const pkg of targets) {
  console.log(`\n[test] ${pkg.name}`)
  const proc = Bun.spawn([process.execPath, 'test', '--isolate', ...forwarded], {
    cwd: pkg.dir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await proc.exited) !== 0) failed = true
}

process.exit(failed ? 1 : 0)
