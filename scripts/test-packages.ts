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

if (targets.length === 0) {
  console.error('[test] no packages with a `bun test` script were found')
  process.exit(1)
}

if (listOnly) {
  for (const pkg of targets) console.log(pkg.name)
  process.exit(0)
}

const testArgs = [
  'test',
  '--isolate',
  ...forwarded,
  ...targets.map((pkg) => pkg.relativeDir),
]

console.log(`[test] ${targets.map((pkg) => pkg.name).join(', ')}`)

const proc = Bun.spawn(['bun', ...testArgs], {
  cwd: repoRoot,
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
