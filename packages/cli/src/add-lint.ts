import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { consola } from 'consola'
import { scaffoldTemplateFile } from './scaffold-templates'
import { writeRoot, writeScaffoldFiles, type WriterOptions } from './utils'

/**
 * Tilde, not caret: oxlint's JS plugin API is alpha and outside its semver, so a
 * caret would let `bun install` float an app onto a minor whose plugin host no
 * longer loads `@guren/cli/oxlint`. Held to the version this repo lints with by
 * `tests/add-lint.test.ts`.
 */
export const OXLINT_RANGE = '~1.81.0'

/** `bunx oxlint` runs the shim under Bun, so an app needs no Node install for it. */
export const LINT_SCRIPTS: Readonly<Record<string, string>> = {
  lint: 'bunx oxlint',
  'lint:fix': 'bunx oxlint --fix',
}

interface Manifest {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

/**
 * Install oxlint with the Guren rules: the `.oxlintrc.json` template, the `lint`
 * scripts, and the `oxlint` dev dependency. Existing scripts and an existing
 * `oxlint` range are left as they are; only the config file honours `force`.
 */
export async function addLint(options: WriterOptions = {}): Promise<string[]> {
  const created = await writeScaffoldFiles([scaffoldTemplateFile('lint', '.oxlintrc.json')], options)
  const manifestPath = resolve(writeRoot(options), 'package.json')
  const raw = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(raw) as Manifest

  let changed = false
  const scripts = manifest.scripts ?? {}
  for (const [name, command] of Object.entries(LINT_SCRIPTS)) {
    if (scripts[name] === undefined) {
      scripts[name] = command
      changed = true
    }
  }
  manifest.scripts = scripts

  const installed = manifest.dependencies?.oxlint ?? manifest.devDependencies?.oxlint
  if (installed === undefined) {
    manifest.devDependencies = { ...manifest.devDependencies, oxlint: OXLINT_RANGE }
    changed = true
  }

  if (!changed) return created

  const indent = /^(\s+)"/mu.exec(raw)?.[1] ?? '  '
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, indent)}\n`, 'utf8')
  if (installed === undefined) {
    consola.info('Run: bun install')
  }
  return [...created, manifestPath]
}
