import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as core from '../src/index'

describe('@guren/core', () => {
  it('re-exports server and orm symbols', () => {
    expect(core.Application).toBeDefined()
    expect(core.Controller).toBeDefined()
    expect(core.Model).toBeDefined()
    expect(core.DrizzleAdapter).toBeDefined()
    expect(core.defineModel).toBeDefined()
  })

  // The expiry helpers live in @guren/server so the Redis stores share them,
  // and index.ts opens with `export * from '@guren/server'` — so re-exporting
  // them anywhere near the barrel would make them public @guren/core API.
  // They are reachable only through the internal subpath.
  it('does not leak the store expiry helpers into the public surface', () => {
    for (const name of ['toDate', 'isExpired', 'toOptionalExpiry', 'decodeJsonColumn']) {
      expect(core[name as keyof typeof core]).toBeUndefined()
    }
  })

  it('bin entry proxies to @guren/cli', async () => {
    const path = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
    const content = await readFile(path, 'utf8')
    expect(content).toContain("@guren/cli/bin")
  })
})
