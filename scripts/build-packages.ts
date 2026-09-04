// Builds every workspace package under packages/ in dependency order, running
// independent packages in parallel (bounded by the machine's core count). The
// order is derived from each package.json, so adding a package (a plugin, for
// example) needs no change here or in the root package.json scripts.
//
//   bun run ./scripts/build-packages.ts                  # build everything
//   bun run ./scripts/build-packages.ts --clean          # wipe dist/ first
//   bun run ./scripts/build-packages.ts --list           # print the order only
//   bun run ./scripts/build-packages.ts --sequential     # one package at a time
//   bun run ./scripts/build-packages.ts cli plugin-cloudflare
//
// Positionals select by directory or package name, preserving dependency order.

import { rm } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

import {
  collectPackages,
  dependencySchedule,
  parseArgs,
  repoRoot,
  selectPackages,
  sortByDependencies,
  type WorkspacePackage,
} from './workspace-packages.ts'

/**
 * Never rejects: the scheduler's bookkeeping depends on every build settling
 * with an exit code.
 */
async function build(pkg: WorkspacePackage, stream: boolean): Promise<number> {
  const started = Date.now()
  let exitCode: number
  try {
    if (stream) {
      const proc = Bun.spawn([process.execPath, 'run', 'build'], {
        cwd: pkg.dir,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      exitCode = await proc.exited
    } else {
      // Buffered and replayed on completion so concurrent builds don't interleave.
      const proc = Bun.spawn([process.execPath, 'run', 'build'], {
        cwd: pkg.dir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
      exitCode = code
    }
  } catch (error) {
    console.error(`[build] ${pkg.name} did not run:`, error)
    return 1
  }

  if (exitCode !== 0) {
    console.error(`[build] ${pkg.name} failed with exit code ${exitCode}`)
    return exitCode
  }

  console.log(`[build] ${pkg.name} done in ${Date.now() - started}ms`)
  return 0
}

/**
 * Untracked `.d.ts` under any package's src/: the native declaration emitter
 * silently writes declarations for files outside its `--rootDir` next to their
 * sources. Tracked `.d.ts` (hand-written ambient types) are not strays. Checked
 * once after every build, since a parallel run's last finisher need not be the
 * package whose program strayed.
 */
function strayDeclarations(): string[] {
  const result = Bun.spawnSync(
    ['git', 'ls-files', '--others', '--exclude-standard', '--', ':(glob)packages/*/src/**/*.d.ts'],
    { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
  )
  if (result.exitCode !== 0) {
    throw new Error(`[build] could not list untracked files (git exited ${result.exitCode}): ${result.stderr}`)
  }
  return result.stdout.toString().split('\n').filter(Boolean)
}

/**
 * Builds packages as their dependencies complete, at most `limit` at a time. On
 * a failure no new builds start; in-flight ones finish and still print.
 */
async function buildAll(
  targets: WorkspacePackage[],
  limit: number,
  allPackages: WorkspacePackage[],
): Promise<number> {
  // The full workspace keeps transitive order for subset selections: `build
  // server openapi` still runs server first via the unselected package between.
  const { remainingDeps, dependents } = dependencySchedule(targets, allPackages)

  // `targets` is already dependency-sorted, so the ready queue is deterministic.
  const ready = targets.filter((pkg) => remainingDeps.get(pkg.name) === 0)
  let running = 0
  let exitCode = 0

  await new Promise<void>((done) => {
    const pump = (): void => {
      while (exitCode === 0 && running < limit && ready.length > 0) {
        const pkg = ready.shift()!
        running += 1
        void build(pkg, limit === 1).then((code) => {
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

// Sorted before filtering, so a buildable package that transitively depends on a
// non-buildable one keeps its order. Also rejects undeclared cycles up front.
const allPackages = sortByDependencies(await collectPackages())
const buildable = allPackages.filter((pkg) => pkg.scripts.build)
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

const exitCode = await buildAll(targets, limit, allPackages)
if (exitCode !== 0) process.exit(exitCode)

const strays = strayDeclarations()
if (strays.length > 0) {
  console.error(
    '[build] declaration files appeared beside package sources — a program reached outside its own package ' +
      '(a sibling pulled in through the root tsconfig paths; see tsconfig.build-base.json):\n' +
      strays.map((file) => `  ${file}`).join('\n'),
  )
  process.exit(1)
}
