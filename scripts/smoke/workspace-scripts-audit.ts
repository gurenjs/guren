// Asserts that no workspace-internal package.json script invokes the CLI as
// `bunx guren` (or `bun x guren` / `npx guren`).
//
// The `guren` package does not exist on npm. Inside this checkout the CLI is
// only reachable through the workspace link (`node_modules/.bin/guren`), and
// whenever that link is missing — fresh clone, partial install, CI cache — the
// runner falls back to the registry and dies on a 404. Workspace apps must run
// the CLI source directly: `bun <path-to>/packages/cli/src/bin.ts`.
//
// Scope: the root manifest plus every workspace member resolved from the root
// `workspaces` globs. Template trees (`packages/create-app/templates/**`,
// `packages/cli/templates/**`) are structurally out of scope — they are not
// workspace members — and `bunx guren` is *correct* there, because scaffolded
// apps install @guren/cli from npm and get a real `node_modules/.bin/guren`.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')

// `bunx guren`, `bunx --bun guren`, `bun x guren`, `npx guren`, `pnpm dlx
// guren`, `guren@…` — the registry-resolving spellings of the CLI, as token
// sequences rather than a regex: a run of `--flag`/`-f` tokens between the
// runner and `guren` is unbounded and package-manager flags are unbounded
// too, and a regex expressing "skip N flag tokens" backtracks exponentially
// on pathological input (CodeQL flagged exactly this). A token scan is
// linear by construction.
const RUNNER_TOKEN_SEQUENCES: readonly (readonly string[])[] = [
  ['bunx'],
  ['bun', 'x'],
  ['npx'],
  ['npm', 'exec'],
  ['pnpm', 'dlx'],
  ['pnpm', 'exec'],
  ['yarn', 'dlx'],
  ['yarn', 'exec'],
]

function isGurenTarget(token: string): boolean {
  return token === 'guren' || token.startsWith('guren@')
}

function invokesRegistryGuren(command: string): boolean {
  const tokens = command.split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    for (const sequence of RUNNER_TOKEN_SEQUENCES) {
      if (!sequence.every((expected, offset) => tokens[i + offset] === expected)) continue
      let next = i + sequence.length
      while (next < tokens.length && tokens[next].startsWith('-')) next++
      if (next < tokens.length && isGurenTarget(tokens[next])) return true
    }
  }
  return false
}

// The sanctioned replacement, when spelled dot-relative. Cwd-shifting forms
// (`cd .. && bun packages/cli/src/bin.ts …`) can't be resolved statically and
// are left to the negative check above.
const RELATIVE_CLI_PATH = /\bbun\s+((?:\.\.?\/)\S*packages\/cli\/src\/bin\.ts)\b/g

interface Manifest {
  workspaces?: string[]
  scripts?: Record<string, string>
}

interface Violation {
  manifest: string
  script: string
  problem: string
}

function collectViolations(manifestPath: string, manifest: Manifest): Violation[] {
  const violations: Violation[] = []
  for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
    if (invokesRegistryGuren(command)) {
      violations.push({
        manifest: manifestPath,
        script,
        problem: `resolves \`guren\` from the registry: ${command}`,
      })
    }
    for (const [, cliPath] of command.matchAll(RELATIVE_CLI_PATH)) {
      if (!existsSync(resolve(repoRoot, dirname(manifestPath), cliPath))) {
        violations.push({
          manifest: manifestPath,
          script,
          problem: `points at a CLI entry that does not exist from this directory: ${cliPath}`,
        })
      }
    }
  }
  return violations
}

async function main(): Promise<void> {
  const rootManifest = (await Bun.file(join(repoRoot, 'package.json')).json()) as Manifest
  if (!Array.isArray(rootManifest.workspaces) || rootManifest.workspaces.length === 0) {
    throw new Error('Root package.json declares no workspaces — audit scope would be empty.')
  }

  const memberManifestPaths: string[] = []
  for (const pattern of rootManifest.workspaces) {
    const glob = new Bun.Glob(`${pattern}/package.json`)
    for await (const path of glob.scan({ cwd: repoRoot })) {
      memberManifestPaths.push(path)
    }
  }
  memberManifestPaths.sort()

  if (memberManifestPaths.length === 0) {
    throw new Error('No workspace members resolved — the workspaces globs no longer match this audit.')
  }

  const violations = collectViolations('package.json', rootManifest)
  for (const manifestPath of memberManifestPaths) {
    const manifest = (await Bun.file(join(repoRoot, manifestPath)).json()) as Manifest
    violations.push(...collectViolations(manifestPath, manifest))
  }

  if (violations.length > 0) {
    console.error('Workspace scripts audit failed: `guren` is not published to npm, so scripts must run packages/cli/src/bin.ts directly — and through a path that resolves.')
    for (const { manifest, script, problem } of violations) {
      console.error(`  ${manifest} → "${script}" ${problem}`)
    }
    console.error('Fix: run the CLI source directly, e.g. `bun ../../packages/cli/src/bin.ts <command>` (adjust the relative path to the member directory).')
    process.exit(1)
  }

  console.log(`Workspace scripts audit passed: ${memberManifestPaths.length} workspace members + root manifest invoke the CLI locally.`)
}

await main()
