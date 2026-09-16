import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { wireConfig } from '../src/provider-registrar'

describe('wireConfig', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-provider-registrar-')
    await mkdir('src')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('adds the definition and its import in one write, once', async () => {
    await writeFile('src/app.ts', `import { createApp } from '@guren/core'
import database from '../config/database.js'

export default createApp({ config: [database] })
`)

    await wireConfig('cache')
    await wireConfig('cache')

    const app = await readFile(resolve('src/app.ts'), 'utf8')
    expect(app).toContain('config: [database, cache]')
    expect(app.match(/import cache from '\.\.\/config\/cache\.js'/g)).toHaveLength(1)
  })

  // An import with no entry fails noUnusedLocals in the app.
  it('writes no import when the config option cannot take the entry', async () => {
    const source = `import { createApp } from '@guren/core'

export default createApp({ config: definitions })
`
    await writeFile('src/app.ts', source)

    await wireConfig('cache')

    expect(await readFile(resolve('src/app.ts'), 'utf8')).toBe(source)
  })
})
