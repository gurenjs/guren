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
  selectPackages,
  sortByDependencies,
  type WorkspacePackage,
} from './workspace-packages.ts'

async function build(pkg: WorkspacePackage): Promise<void> {
  const started = Date.now()
  const proc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: pkg.dir,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`${pkg.name} build failed with exit code ${exitCode}`)
  }

  console.log(`[build] ${pkg.name} done in ${Date.now() - started}ms`)
}

const args = process.argv.slice(2)
const clean = args.includes('--clean')
const listOnly = args.includes('--list')
const selectors = args.filter((arg) => !arg.startsWith('--'))

const buildable = (await collectPackages()).filter((pkg) => pkg.scripts.build)
const targets = selectPackages(sortByDependencies(buildable), selectors)

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
  await build(pkg)
}
