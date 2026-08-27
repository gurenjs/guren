/**
 * Type-checks every scaffold-template project and proves that, together, they
 * cover every shipped template.
 *
 * The templates under `packages/cli/templates/scaffold/` are app-shaped
 * sources no other tsconfig reaches — the root typecheck deliberately
 * excludes them. They are split across `tsconfig.templates*.json` projects
 * because `rootDirs` merges every listed scaffold into one virtual root, so
 * colliding scaffolds need separate projects (see
 * `packages/cli/src/scaffold-templates.ts`). That split has a silent failure
 * mode this script exists to close: exclude a scaffold from the main project
 * and forget the follow-up config (or forget to run it), and the scaffold is
 * typechecked by *nothing* while `bun run typecheck` stays green.
 *
 * So, like `check-build-configs.ts` for `tsconfig.build.json`, the configs
 * are discovered rather than listed: every `tsconfig.templates*.json` in
 * `packages/cli/` is run through `tsc -p`, and the union of the programs'
 * file lists (`--listFilesOnly`, free once tsc is spawned anyway) must
 * contain every `.ts`/`.tsx` under `templates/scaffold/`. A new config needs
 * no script wiring; a template covered by no config names itself in the
 * failure.
 *
 * Usage: bun scripts/check-template-configs.ts
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
