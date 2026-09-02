import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * What an installed copy of this package actually contains, and what its
 * `exports` map points at.
 *
 * `@guren/plugin-mcp/oauth` is imported by a worker `guren cloudflare:build
 * --mcp-oauth` generates — code that exists only in a *deployed app*, which no
 * gate in this repository runs. So the two ways this subpath breaks are both
 * invisible here: an `exports` entry naming a file the build does not emit,
 * and a `files` list that publishes `dist/` but not the chunk the entry
 * imports. Both surface as a resolution failure on someone's deploy.
 *
 * Skipped when the package has not been built — a pack of an unbuilt checkout
 * cannot answer the question either way.
 */
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const built = existsSync(`${packageDir}/dist/index.js`)

function packedFiles(): string[] {
  const result = Bun.spawnSync({
    cmd: ['bun', 'pm', 'pack', '--dry-run'],
    cwd: packageDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(`bun pm pack --dry-run failed:\n${result.stderr.toString()}`)
  }

  return result.stdout
    .toString()
    .split('\n')
    .flatMap((line) => {
      const match = /^packed\s+\S+\s+(.+)$/.exec(line.trim())
      return match ? [match[1]!] : []
    })
}

describe.if(built)('published files', () => {
  test('should publish every file the exports map names', () => {
    const files = packedFiles()
    const manifest = JSON.parse(readFileSync(`${packageDir}/package.json`, 'utf8')) as {
      exports: Record<string, Record<string, string>>
    }

    const named = Object.values(manifest.exports).flatMap((entry) => Object.values(entry))
    expect(named).toContain('./dist/oauth.js')

    for (const target of named) {
      expect(files).toContain(target.replace(/^\.\//, ''))
    }
  })

  /**
   * The seam module is a *shared chunk* under a content-hashed name, imported
   * by both built entries. `files: ["dist"]` covers it today; a narrower list
   * naming individual files would not, and the failure would be a worker that
   * cannot resolve an import nothing in this repo ever asked it to.
   */
  test('should publish the chunk both entries import', () => {
    const files = packedFiles()
    const oauth = readFileSync(`${packageDir}/dist/oauth.js`, 'utf8')

    const imported = [...oauth.matchAll(/from\s+"\.\/([^"]+)"/g)].map((match) => match[1]!)
    expect(imported.length).toBeGreaterThan(0)

    for (const chunk of imported) {
      expect(files).toContain(`dist/${chunk}`)
    }
  })
})
