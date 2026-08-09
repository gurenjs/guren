// Builds every workspace package under packages/ in dependency order, running
// independent packages in parallel (bounded by the machine's core count).
//
// The order is derived from each package.json rather than hand-maintained, so
// adding a package (a plugin, for example) needs no change here or in the root
// package.json scripts.
//
//   bun run ./scripts/build-packages.ts                  # build everything
//   bun run ./scripts/build-packages.ts --clean          # wipe dist/ first
//   bun run ./scripts/build-packages.ts --list           # print the order only
//   bun run ./scripts/build-packages.ts --sequential     # one package at a time
//   bun run ./scripts/build-packages.ts cli plugin-cloudflare
//
// Positional arguments select packages by directory name or package name; the
// dependency order of the selection is preserved.

import { rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

import {
  collectPackages,
  dependencySchedule,
  parseArgs,
  selectPackages,
  sortByDependencies,
  type WorkspacePackage,
} from './workspace-packages.ts'

/** Returns the child's exit code; a non-zero code means the caller should stop and propagate it. */
async function build(pkg: WorkspacePackage): Promise<number> {
  const started = Date.now()
  // Output is buffered and replayed on completion so concurrent builds don't
  // interleave their lines.
  const proc = Bun.spawn([process.execPath, 'run', 'build'], {
    cwd: pkg.dir,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)

  if (exitCode !== 0) {
    console.error(`[build] ${pkg.name} failed with exit code ${exitCode}`)
    return exitCode
  }

  console.log(`[build] ${pkg.name} done in ${Date.now() - started}ms`)
  return 0
}

/**
 * Builds the packages as their dependencies complete, at most `limit` at a
 * time. On a failure no new builds start; in-flight ones finish and their
 * output is still printed. Returns the first failure's exit code, or 0.
 */
async function buildAll(
  targets: WorkspacePackage[],
  limit: number,
): Promise<number> {
  const { remainingDeps, dependents } = dependencySchedule(targets)

  // `targets` is already dependency-sorted, so the ready queue starts (and
  // stays) in a deterministic order.
  const ready = targets.filter((pkg) => remainingDeps.get(pkg.name) === 0)
  let running = 0
  let exitCode = 0

  await new Promise<void>((done) => {
    const pump = (): void => {
      while (exitCode === 0 && running < limit && ready.length > 0) {
        const pkg = ready.shift()!
        running += 1
        void build(pkg).then((code) => {
          running -= 1
          if (code !== 0) {
            if (exitCode === 0) exitCode = code
          } else {
            for (const dependent of dependents.get(pkg.name) ?? []) {
              const left = remainingDeps.get(dependent.name)! - 1
              remainingDeps.set(dependent.name, left)
              if (left === 0) ready.push(dependent)
            }
          }
          pump()
        })
      }
      if (running === 0 && (exitCode !== 0 || ready.length === 0)) done()
    }
    pump()
  })

  return exitCode
}

const { flags, positionals: selectors } = parseArgs(process.argv.slice(2), [
  'clean',
  'list',
  'sequential',
])
const clean = flags.clean
const listOnly = flags.list

// Sort the full workspace graph — including packages without a `build` script
// — before filtering, so a buildable package that transitively depends on a
// non-buildable one keeps its correct relative order. This also rejects any
// undeclared dependency cycle before the scheduler runs.
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
  await Promise.all(
    targets.map((pkg) =>
      rm(join(pkg.dir, 'dist'), { recursive: true, force: true }),
    ),
  )
  console.log(`[build] removed dist/ from ${targets.length} package(s)`)
}

const limit = flags.sequential
  ? 1
  : Math.max(1, Math.min(availableParallelism(), targets.length))

console.log(`[build] ${targets.map((pkg) => pkg.name).join(' → ')}`)
if (limit > 1) console.log(`[build] up to ${limit} packages in parallel`)

const exitCode = await buildAll(targets, limit)
if (exitCode !== 0) process.exit(exitCode)
