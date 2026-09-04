import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Pins the premise behind `"sideEffects": false` in packages/server/package.json:
 * nothing in `src/` may be imported *purely* for a side effect, which is what lets
 * a deployed function drop unimported subsystems (roughly 40% of the bundle).
 *
 * Source-level because `bun test` never bundles — a violation stays green
 * everywhere and surfaces only as a subsystem that silently stopped initialising.
 * Deliberately narrow: bare imports only, so a module with exports plus top-level
 * statements (`src/http/dev-banner.ts`) is not flagged.
 */

const SERVER_ROOT = join(import.meta.dir, '..')
const SRC_ROOT = join(SERVER_ROOT, 'src')

/** `import './x'` / `import "x"` — a module loaded only for its side effect. */
const BARE_IMPORT = /^\s*import\s+(['"])([^'"]+)\1\s*;?\s*$/gm

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(path)
    }
  }
  return found
}

describe('@guren/server sideEffects declaration', () => {
  test('package.json still declares sideEffects: false', () => {
    // Read rather than imported: this is the shipped manifest, and the rest of
    // this file is only meaningful while it says exactly this.
    const manifest = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8'))
    expect(manifest.sideEffects).toBe(false)
  })

  test('no module under src/ is imported purely for a side effect', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(SRC_ROOT)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(BARE_IMPORT)) {
        offenders.push(`${file.slice(SERVER_ROOT.length + 1)}: import '${match[2]}'`)
      }
    }

    // Message rather than a bare toEqual([]): whoever trips this reads it in a
    // failing CI log with no other context.
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `@guren/server declares "sideEffects": false, so a bundler may drop any module whose ` +
            `exports go unused — including these, which are imported only to run them:\n  ` +
            `${offenders.join('\n  ')}\n` +
            `Bundled and serverless builds would silently skip them while every test stays green. ` +
            `Either give the module an export its importer uses, or change the declaration to the ` +
            `array form naming these files (see @guren/orm, which does this for instance-guard).`,
    ).toEqual([])
  })
})
