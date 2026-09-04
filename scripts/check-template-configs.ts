/**
 * Type-checks every scaffold-template project and proves that, together, they
 * cover every shipped template. Usage: bun scripts/check-template-configs.ts
 *
 * `packages/cli/templates/scaffold/` is reached by no other tsconfig (the root
 * typecheck excludes it) and is split across `tsconfig.templates*.json` projects
 * because `rootDirs` merges every scaffold into one virtual root. A scaffold left
 * out of every config is typechecked by nothing, so the configs are discovered and
 * the union of their `--listFilesOnly` lists must contain every `.ts`/`.tsx`.
 */
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { repoRoot } from './workspace-packages'

const cliDir = join(repoRoot, 'packages/cli')
const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc')

const configs = readdirSync(cliDir)
  .filter((name) => name.startsWith('tsconfig.templates') && name.endsWith('.json'))
  .sort()

if (configs.length === 0) {
  console.error('[check-template-configs] no tsconfig.templates*.json found in packages/cli — the scaffold templates are typechecked by nothing.')
  process.exit(1)
}

let failures = 0
const covered = new Set<string>()

for (const config of configs) {
  const check = Bun.spawnSync([process.execPath, tsc, '-p', config, '--noEmit', '--pretty', 'false'], {
    cwd: cliDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (check.exitCode === 0) {
    console.log(`[check-template-configs] ${config} ok`)
  } else {
    failures += 1
    console.error(`[check-template-configs] ${config}: tsc exited ${check.exitCode}`)
  }

  // Collected even when the check fails: coverage and correctness are
  // separate findings, and reporting both beats stopping at the first.
  const list = Bun.spawnSync([process.execPath, tsc, '-p', config, '--listFilesOnly'], {
    cwd: cliDir,
    stdout: 'pipe',
    stderr: 'inherit',
  })
  for (const line of list.stdout.toString().split('\n')) {
    if (line.trim() !== '') covered.add(resolve(cliDir, line.trim()))
  }
}

const templateRoot = join(cliDir, 'templates/scaffold')
const uncovered = readdirSync(templateRoot, { recursive: true })
  .map(String)
  .filter((path) => /\.tsx?$/.test(path) && !path.endsWith('.d.ts'))
  .filter((path) => !covered.has(resolve(templateRoot, path)))
  .sort()

if (uncovered.length > 0) {
  failures += 1
  console.error('[check-template-configs] templates covered by no tsconfig.templates*.json project (add the scaffold to one, or give it its own config):')
  for (const path of uncovered) console.error(`  templates/scaffold/${path}`)
}

process.exit(failures === 0 ? 0 : 1)
