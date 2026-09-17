import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { wireAppProvider, wireConfig } from '../src/provider-registrar'

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

  // A second `import cache` is a duplicate declaration, which the app cannot load.
  it('keeps an import of the definition spelled without the extension', async () => {
    await writeFile('src/app.ts', `import { createApp } from '@guren/core'
import cache from '../config/cache'

export default createApp({ config: [cache] })
`)

    await wireConfig('cache')

    const app = await readFile(resolve('src/app.ts'), 'utf8')
    expect(app.match(/^import cache from/gm)).toHaveLength(1)
    expect(app).toContain('config: [cache]')
  })

  // A second entry is a second definition for the `cache` key, which createApp refuses at boot.
  it('registers nothing when the definition is already imported under another name', async () => {
    const source = `import { createApp } from '@guren/core'
import cacheConfig from '@/config/cache.js'

export default createApp({ config: [cacheConfig] })
`
    await writeFile('src/app.ts', source)

    await wireConfig('cache')

    expect(await readFile(resolve('src/app.ts'), 'utf8')).toBe(source)
  })

  it('registers an imported but unregistered definition under the name it was imported as', async () => {
    await writeFile('src/app.ts', `import { createApp } from '@guren/core'
import cacheConfig from '../config/cache.ts'

export default createApp({ config: [] })
`)

    await wireConfig('cache')

    const app = await readFile(resolve('src/app.ts'), 'utf8')
    expect(app).toContain('config: [cacheConfig]')
    expect(app).not.toContain('import cache from')
  })

  it('applies the same rule to a scaffolded provider', async () => {
    const source = `import { createApp } from '@guren/core'
import Cache from '../app/Providers/CacheProvider'

export default createApp({ providers: [Cache] })
`
    await writeFile('src/app.ts', source)

    await wireAppProvider('CacheProvider')

    expect(await readFile(resolve('src/app.ts'), 'utf8')).toBe(source)
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
