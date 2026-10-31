import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { cliDependencyRange } from './cli-manifest'
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
  return cliDependencyRange('peerDependencies', 'oxlint')
}

/** `bunx oxlint` runs the shim under Bun, so an app needs no Node install for it. */
export const LINT_SCRIPTS: Readonly<Record<string, string>> = {
  lint: 'bunx oxlint',
  'lint:fix': 'bunx oxlint --fix',
}

// The `resources/js` override as the lint template writes it; `withoutRawColorOverride` throws
// if the template drifts from this shape, so the drop below cannot silently stop matching.
const RAW_COLOR_OVERRIDE = /,\n {4}\{\n(?: {6}\/\/[^\n]*\n)* {6}"files": \["resources\/js\/\*\*"\],\n {6}"rules": \{ "guren\/no-raw-color": "error" \}\n {4}\}/u

export function withoutRawColorOverride(config: string): string {
  if (!RAW_COLOR_OVERRIDE.test(config)) throw new Error('the lint template no longer carries the guren/no-raw-color override')
  return config.replace(RAW_COLOR_OVERRIDE, '')
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
  // An app older than the Guren UI tokens has nothing to replace a palette class with, so
  // `guren/no-raw-color` would only turn its first lint red.
  const config = scaffoldTemplateFile('lint', '.oxlintrc.json')
  const hasTokens = existsSync(resolve(writeRoot(options), 'resources/css/guren.css'))
  if (!hasTokens) config.contents = withoutRawColorOverride(config.contents)
  const created = await writeScaffoldFiles([config], options)
  if (!hasTokens && existsSync(resolve(writeRoot(options), 'resources/js'))) {
    consola.info('resources/css/guren.css not found, so guren/no-raw-color is left out of .oxlintrc.json. Add its resources/js/** override once the pages style with Guren UI tokens.')
  }

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
