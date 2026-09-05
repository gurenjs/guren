import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  MCP_OAUTH_CONTROLLER_FILE,
  MCP_OAUTH_TEMPLATE_FILES,
  loadMcpOAuthTemplate,
} from '../src/templates'

/**
 * `@guren/plugin-cloudflare/env` exists so application code can reach the
 * Workers env holder without the root entry's `buildCloudflareOutput` (and
 * `node:fs`, `node:path`, `node:url`) coming with it on every `bun run dev` boot
 * and in every wrangler bundle. Nothing else catches a regression: an import from
 * the root typechecks and works; the only symptom is a slower boot and fatter bundle.
 */
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const built = existsSync(`${packageDir}/dist/env.js`)

/** A distinctive string only `build.ts` puts in the bundle. */
const BUILD_ONLY_MARKER = 'Cloudflare build:'

describe('lean env subpath', () => {
  test('should be what the consent controller imports getWorkersEnv from', () => {
    const controller = loadMcpOAuthTemplate(MCP_OAUTH_CONTROLLER_FILE)

    expect(controller).toContain("from '@guren/plugin-cloudflare/env'")
    // The root entry, imported by name, is the regression. Spelled as the
    // exact specifier so `.../env` does not satisfy it.
    expect(controller).not.toContain("from '@guren/plugin-cloudflare'")
  })

  test('should be the only plugin entry any template imports', () => {
    for (const path of MCP_OAUTH_TEMPLATE_FILES) {
      expect(loadMcpOAuthTemplate(path)).not.toContain("from '@guren/plugin-cloudflare'")
    }
  })

  test('should have no imports at all in source', () => {
    const source = readFileSync(`${packageDir}/src/env.ts`, 'utf8')

    // Not "no node builtins" but *no imports*: the module's whole value is that
    // its transitive graph is empty, and any import is the first step back.
    expect(source).not.toMatch(/^\s*import\s/mu)
    expect(source).not.toMatch(/\brequire\(/u)
  })
})

describe.if(built)('lean env subpath (built)', () => {
  test('should carry no build tooling into the built entry', () => {
    // Comments stripped before the absence assertions: this module's own header
    // names the builtins it exists to keep out, and a raw search would find the
    // explanation and report it as the thing itself.
    const bundle = new Bun.Transpiler({ loader: 'js' }).transformSync(
      readFileSync(`${packageDir}/dist/env.js`, 'utf8'),
    )

    expect(bundle).not.toContain('node:fs')
    expect(bundle).not.toContain('node:path')
    expect(bundle).not.toContain(BUILD_ONLY_MARKER)
    // Nor by importing a chunk that has them: this entry must stand alone.
    expect(bundle).not.toMatch(/\bfrom\s*["']\.\//u)
    // And it must actually contain the functions, or the assertions above
    // would pass on an empty file.
    expect(bundle).toContain('getWorkersEnv')
  })

  /**
   * The root still re-exports the same names. Asserted because "move the module"
   * and "move the module and drop the old names" look identical in a diff.
   */
  test('should leave the root re-export in place', () => {
    const bundle = readFileSync(`${packageDir}/dist/index.js`, 'utf8')

    expect(bundle).toContain('getWorkersEnv')
    expect(bundle).toContain('captureWorkersEnv')
    expect(bundle).toContain('resetWorkersEnv')
  })

  test('should publish the subpath the exports map names', () => {
    const manifest = JSON.parse(readFileSync(`${packageDir}/package.json`, 'utf8')) as {
      exports: Record<string, Record<string, string>>
    }

    expect(Object.keys(manifest.exports)).toContain('./env')
    for (const target of Object.values(manifest.exports['./env']!)) {
      expect(existsSync(`${packageDir}/${target.replace(/^\.\//, '')}`)).toBe(true)
    }
  })
})
