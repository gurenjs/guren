import { describe, test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MCP_OAUTH_TEMPLATE_FILES } from '../src/templates'

/**
 * What an installed copy of this package actually contains. `--mcp-oauth` reads
 * its scaffold templates from `templates/`, outside `dist/` and published only
 * because `files` names it: drop that entry and every gate here stays green while
 * the flag ENOENTs on the first app that installs the package. Skipped when not
 * built: a pack reporting no `dist` files cannot answer the question either.
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
  test('should publish every mcp-oauth template the scaffold reads', () => {
    const files = packedFiles()

    for (const path of MCP_OAUTH_TEMPLATE_FILES) {
      expect(files).toContain(`templates/mcp-oauth/${path}`)
    }
  })

  test('should publish the built entry points', () => {
    const files = packedFiles()

    expect(files).toContain('dist/index.js')
    expect(files).toContain('dist/commands.js')
  })
})
