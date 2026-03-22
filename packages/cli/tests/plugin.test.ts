import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { installPlugin } from '../src/plugin'

describe('installPlugin', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-plugin-')
    await mkdir('src', { recursive: true })
    await writeFile('src/app.ts', `import { createApp } from '@guren/core'

const app = createApp({
  routes: () => {},
  providers: [],
})

export default app
`)
    await writeFile('package.json', JSON.stringify({
      name: 'plugin-test-app',
      type: 'module',
      dependencies: {
        '@guren/core': '^0.2.0-alpha.7',
      },
    }, null, 2))
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('registers provider import and provider entry', async () => {
    const updated = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

    expect(updated).toContain('src/app.ts')
    expect(updated).toContain('Run: bun add @acme/guren-plugin-audit')

    const app = await readFile('src/app.ts', 'utf8')
    expect(app).toContain("import { AcmeGurenPluginAuditProvider } from '@acme/guren-plugin-audit'")
    expect(app).toContain('providers: [AcmeGurenPluginAuditProvider]')
  })

  it('is idempotent when plugin provider already exists', async () => {
    await installPlugin({ packageName: '@acme/guren-plugin-audit' })
    const second = await installPlugin({ packageName: '@acme/guren-plugin-audit' })

    expect(second).toContain('src/app.ts (already registered)')

    const app = await readFile('src/app.ts', 'utf8')
    const occurrences = app.match(/AcmeGurenPluginAuditProvider/g)?.length ?? 0
    expect(occurrences).toBe(2) // one import + one providers array entry
  })

  it('does not suggest installation if dependency already exists', async () => {
    await writeFile('package.json', JSON.stringify({
      name: 'plugin-test-app',
      type: 'module',
      dependencies: {
        '@guren/core': '^0.2.0-alpha.7',
        '@acme/guren-plugin-audit': '^1.0.0',
      },
    }, null, 2))

    const result = await installPlugin({ packageName: '@acme/guren-plugin-audit' })
    expect(result.some(item => item.startsWith('Run: bun add'))).toBe(false)
  })
})
