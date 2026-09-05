import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consola } from 'consola'
import type { DependencyManifest } from './drizzle-pins'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeRoot, writeScaffoldFiles, type WriterOptions } from './utils'

/**
 * The oxlint range an app gets: this package's own optional peer range, read from
 * `../package.json` (this package's root from `dist/` and `src/` alike), so the
 * claim `@guren/cli/oxlint` makes about its host and the range `add lint` writes
 * cannot drift apart. Tilde on purpose: oxlint's JS plugin API is alpha and
 * outside its semver, and a caret would float an app past the tested line.
 */
export function oxlintRange(): string {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DependencyManifest
  const range = manifest.peerDependencies?.oxlint
  if (range === undefined) {
    throw new Error('@guren/cli declares no oxlint peer range — add lint has nothing to install')
  }
  return range
}

/** `bunx oxlint` runs the shim under Bun, so an app needs no Node install for it. */
export const LINT_SCRIPTS: Readonly<Record<string, string>> = {
  lint: 'bunx oxlint',
  'lint:fix': 'bunx oxlint --fix',
}

interface Manifest extends DependencyManifest {
  scripts?: Record<string, string>
}

/**
 * Install oxlint with the Guren rules: the `.oxlintrc.json` template, the `lint`
 * scripts, and the `oxlint` dev dependency. Existing scripts and an existing
 * `oxlint` range are left as they are; only the config file honours `force`.
 */
export async function addLint(options: WriterOptions = {}): Promise<string[]> {
  // Read the manifest before the config write: a missing or malformed package.json
  // must not leave a half-installed lint setup (or, with --force, a clobbered config).
  const manifestPath = resolve(writeRoot(options), 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
  const created = await writeScaffoldFiles([scaffoldTemplateFile('lint', '.oxlintrc.json')], options)

  const scripts = manifest.scripts ?? {}
  const missingScripts = Object.entries(LINT_SCRIPTS).filter(([name]) => scripts[name] === undefined)
  const installed = manifest.dependencies?.oxlint ?? manifest.devDependencies?.oxlint
  if (missingScripts.length === 0 && installed !== undefined) return created

  manifest.scripts = { ...scripts, ...Object.fromEntries(missingScripts) }
  if (installed !== undefined && installed !== oxlintRange()) {
    consola.warn(`package.json already has oxlint ${installed}; @guren/cli/oxlint is tested against ${oxlintRange()}`)
  }
  if (installed === undefined) {
    manifest.devDependencies = { ...manifest.devDependencies, oxlint: oxlintRange() }
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (installed === undefined) {
    consola.info('Run: bun install')
  }
  return [...created, manifestPath]
}
