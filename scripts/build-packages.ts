// Builds every workspace package under packages/ in dependency order.
//
// The order is derived from each package.json rather than hand-maintained, so
// adding a package (a plugin, for example) needs no change here or in the root
// package.json scripts.
//
//   bun run ./scripts/build-packages.ts                  # build everything
//   bun run ./scripts/build-packages.ts --clean          # wipe dist/ first
//   bun run ./scripts/build-packages.ts --list           # print the order only
//   bun run ./scripts/build-packages.ts cli plugin-cloudflare
//
// Positional arguments select packages by directory name or package name; the
// dependency order of the selection is preserved.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  collectPackages,
  parseArgs,
  selectPackages,
  sortByDependencies,
  type WorkspacePackage,
} from './workspace-packages.ts'

/** Returns the child's exit code; a non-zero code means the caller should stop and propagate it. */
async function build(pkg: WorkspacePackage): Promise<number> {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, 'run', 'build'], {
    cwd: pkg.dir,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error(`[build] ${pkg.name} failed with exit code ${exitCode}`)
    return exitCode
  }

  console.log(`[build] ${pkg.name} done in ${Date.now() - started}ms`)
  return 0
}

const { flags, positionals: selectors } = parseArgs(process.argv.slice(2), [
  'clean',
  'list',
])
const clean = flags.clean
const listOnly = flags.list

// Sort the full workspace graph — including packages without a `build` script
// — before filtering, so a buildable package that transitively depends on a
// non-buildable one keeps its correct relative order.
const buildable = sortByDependencies(await collectPackages()).filter(
  (pkg) => pkg.scripts.build,
)
const targets = selectPackages(buildable, selectors)

if (listOnly) {
  for (const [index, pkg] of targets.entries()) {
    console.log(`${index + 1}. ${pkg.name}`)
  }
  process.exit(0)
}

if (clean) {
  for (const pkg of targets) {
    await rm(join(pkg.dir, 'dist'), { recursive: true, force: true })
  }
  console.log(`[build] removed dist/ from ${targets.length} package(s)`)
}

console.log(`[build] ${targets.map((pkg) => pkg.name).join(' → ')}`)

for (const pkg of targets) {
  const exitCode = await build(pkg)
  if (exitCode !== 0) process.exit(exitCode)
}
