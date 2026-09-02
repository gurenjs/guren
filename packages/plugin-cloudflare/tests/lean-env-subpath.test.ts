import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MCP_OAUTH_TEMPLATE_FILES, loadMcpOauthTemplate } from '../src/templates'

/**
 * `@guren/plugin-cloudflare/env` exists so application code can reach the
 * Workers env holder without the root entry's `buildCloudflareOutput` — and
 * `node:fs`, `node:path`, `node:url`, plus the whole deploy generator — coming
 * with it. A scaffolded controller importing from the root would pull all of
 * that into the app's route graph on every `bun run dev` boot and into the
 * wrangler bundle on every deploy, for three functions that import nothing.
 *
 * Nothing else can catch a regression here. The import would still typecheck,
 * still resolve, still work; the only symptom is a slower boot and a fatter
 * bundle, which no assertion in this repository makes.
 */
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const built = existsSync(`${packageDir}/dist/env.js`)

/** A distinctive string only `build.ts` puts in the bundle. */
const BUILD_ONLY_MARKER = 'Cloudflare build:'

describe('lean env subpath', () => {
  test('should be what the consent controller imports getWorkersEnv from', () => {
    const controller = loadMcpOauthTemplate('app/Http/Controllers/McpOAuthController.ts')

    expect(controller).toContain("from '@guren/plugin-cloudflare/env'")
    // The root entry, imported by name, is the regression. Spelled as the
    // exact specifier so `.../env` does not satisfy it.
    expect(controller).not.toContain("from '@guren/plugin-cloudflare'")
  })

  test('should be the only plugin entry any template imports', () => {
    for (const path of MCP_OAUTH_TEMPLATE_FILES) {
      expect(loadMcpOauthTemplate(path)).not.toContain("from '@guren/plugin-cloudflare'")
    }
  })

  test('should have no imports at all in source', () => {
    const source = readFileSync(`${packageDir}/src/env.ts`, 'utf8')

    // Not "no node builtins" but *no imports*: the module's whole value is
    // that its transitive graph is empty, and any import at all is the first
    // step back to a graph nobody is watching.
    expect(source).not.toMatch(/^\s*import\s/mu)
    expect(source).not.toMatch(/\brequire\(/u)
  })
})

describe.if(built)('lean env subpath (built)', () => {
  test('should carry no build tooling into the built entry', () => {
    // Comments stripped before the absence assertions: this module's own
    // header explains at length which builtins it exists to keep out, and a
    // raw search finds the explanation and reports it as the thing itself.
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
   * The root still re-exports the same names, so an app that already imports
   * them from there keeps working. Asserted because "move the module" and
   * "move the module and drop the old names" look identical in a diff.
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
