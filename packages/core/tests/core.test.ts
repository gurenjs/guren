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
  })

  it('bin entry proxies to @guren/cli', async () => {
    const path = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
    const content = await readFile(path, 'utf8')
    expect(content).toContain("@guren/cli/bin")
  })
})
