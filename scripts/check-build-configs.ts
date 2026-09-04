/**
 * Type-checks every package through the tsconfig its bundler reads.
 *
 * tsdown emits declarations with `tsgo --noCheck`, so an unresolvable sibling
 * does not fail the build: it turns every type inferred from it into `any` in
 * the published .d.ts, and the root typecheck cannot see it because its path
 * mappings resolve siblings to their sources. Covers packages with a
 * `tsconfig.build.json`; run after `bun run build`, or every sibling import
 * reports TS2307.
 *
 * Usage: bun scripts/check-build-configs.ts
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { collectPackages, repoRoot } from './workspace-packages'

const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc')

let failures = 0
for (const pkg of await collectPackages()) {
  const config = join(pkg.dir, 'tsconfig.build.json')
  if (!existsSync(config)) continue
  const { exitCode } = Bun.spawnSync([process.execPath, tsc, '-p', config, '--noEmit', '--pretty', 'false'], {
    cwd: pkg.dir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (exitCode === 0) {
    console.log(`[check-build-configs] ${pkg.name} ok`)
    continue
  }
  failures += 1
  console.error(`[check-build-configs] ${pkg.name}: tsc -p tsconfig.build.json exited ${exitCode} (unbuilt siblings show up as TS2307; run \`bun run build\` first)`)
}

process.exit(failures === 0 ? 0 : 1)
