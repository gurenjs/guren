import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * What an installed copy contains, and what its `exports` map points at.
 * `@guren/plugin-mcp/oauth` is imported only by a worker `guren cloudflare:build
 * --mcp-oauth` generates, which no gate here runs — an `exports` entry naming a
 * file the build does not emit, or a `files` list missing the chunk it imports,
 * would surface only as a resolution failure on someone's deploy. Skipped when unbuilt.
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
   * by both built entries. `files: ["dist"]` covers it; a narrower list naming
   * individual files would not.
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
