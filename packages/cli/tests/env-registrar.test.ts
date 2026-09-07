import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { appendEnvEntry } from '../src/env-registrar'

const ENTRY = `
# Which store CacheProvider uses.
CACHE_STORE=memory
`

describe('appendEnvEntry', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-env-registrar-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('appends to both env files, separated from what is already there', async () => {
    await writeFile('.env.example', 'APP_KEY=\n')
    await writeFile('.env', 'APP_KEY=generated')

    await appendEnvEntry('CACHE_STORE', ENTRY)

    for (const file of ['.env.example', '.env']) {
      const content = await readFile(resolve(file), 'utf8')
      expect(content).toContain('APP_KEY=')
      expect(content).toContain('\n\n# Which store CacheProvider uses.\nCACHE_STORE=memory\n')
    }
  })

  it('creates neither file', async () => {
    await appendEnvEntry('CACHE_STORE', ENTRY)

    expect(existsSync(resolve('.env.example'))).toBe(false)
    expect(existsSync(resolve('.env'))).toBe(false)
  })

  it('treats a commented mention as a choice already made', async () => {
    await writeFile('.env.example', 'APP_KEY=\n# CACHE_STORE=redis\n')

    await appendEnvEntry('CACHE_STORE', ENTRY)

    const content = await readFile(resolve('.env.example'), 'utf8')
    expect(content.match(/CACHE_STORE/g)).toHaveLength(1)
  })

  it('is idempotent over the entry it wrote itself', async () => {
    await writeFile('.env.example', 'APP_KEY=\n')

    await appendEnvEntry('CACHE_STORE', ENTRY)
    const once = await readFile(resolve('.env.example'), 'utf8')
    await appendEnvEntry('CACHE_STORE', ENTRY)

    expect(await readFile(resolve('.env.example'), 'utf8')).toBe(once)
  })

  it('refuses an entry that does not assign the key it is probed by', async () => {
    await writeFile('.env.example', 'APP_KEY=\n')

    // Without the guard the probe never matches what was written, so every
    // re-run appends the entry again.
    await expect(appendEnvEntry('CACHE_STORE', '\n# CACHE_STORE is a thing\n'))
      .rejects.toThrow('does not assign CACHE_STORE=')
  })
})
