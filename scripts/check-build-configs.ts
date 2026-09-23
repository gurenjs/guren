/**
 * `bun scripts/check-build-configs.ts`, after `bun run build`: every package's
 * `tsconfig.json` must extend the root config and set no `paths` of its own
 * (#560), then each `tsconfig.build.json` is type-checked with checking on.
 * tsdown emits declarations with `tsgo --noCheck`, so an unresolvable sibling does
 * not fail the build: its inferred types become `any` in the published .d.ts, and
 * the root typecheck cannot see it because its paths resolve siblings to sources.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { collectPackages, repoRoot } from './workspace-packages'

const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc')
const rootTsconfig = join(repoRoot, 'tsconfig.json')

let failures = 0

// Bun resolves `@guren/*` per importing file through the nearest tsconfig.json, so
// a package whose runtime config drops the root paths loads siblings from dist
// while the app loads src: two copies of each module in one process.
const runtimeConfigs = readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(repoRoot, 'packages', entry.name, 'tsconfig.json'))
  .filter((config) => existsSync(config))
for (const config of runtimeConfigs) {
  const label = config.slice(repoRoot.length + 1)
  const parsed = Bun.JSONC.parse(readFileSync(config, 'utf8')) as {
    extends?: unknown
    compilerOptions?: Record<string, unknown>
  }
  if (typeof parsed.extends !== 'string' || resolve(config, '..', parsed.extends) !== rootTsconfig) {
    failures += 1
    console.error(`[check-build-configs] ${label}: must extend the root tsconfig.json as "../../tsconfig.json", and only it; Bun ignores an extension-less or array extends that TypeScript accepts, and a runtime config that loses the root paths makes Bun load a second copy of every sibling from dist.`)
  }
  if (parsed.compilerOptions && 'paths' in parsed.compilerOptions) {
    failures += 1
    console.error(`[check-build-configs] ${label}: sets compilerOptions.paths; move it to tsconfig.build.json (layering tsconfig.build-base.json). Bun reads this file at runtime, so the package would load siblings from dist while the app loads src: two copies of each module in one dev process.`)
  }
}
if (runtimeConfigs.length === 0) {
  failures += 1
  console.error('[check-build-configs] found no packages/*/tsconfig.json to check')
} else if (failures === 0) {
  console.log(`[check-build-configs] ${runtimeConfigs.length} runtime tsconfig.json files inherit the root paths`)
}

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
