import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadResolvedConfig } from '../src/resolved-config'
import { createTempWorkspace, linkWorkspaceCore, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const ENV_SCHEMA = `import { defineEnv, Env } from '@guren/core'

export default defineEnv({
  CACHE_STORE: Env.enum(['memory', 'redis']).default('memory'),
})
`

const CACHE_CONFIG = `import { defineConfig } from '@guren/core'

export default defineConfig({
  key: 'cache',
  resolve: (env) => ({ default: env.CACHE_STORE }),
  bind: () => {},
})
`

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-resolved-config-')
  await linkWorkspaceCore(workspace.dir)
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('loadResolvedConfig', () => {
  test('resolves each definition against the validated env and records the keys it read', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': ENV_SCHEMA, 'config/cache.ts': CACHE_CONFIG })

    const resolved = await loadResolvedConfig(workspace.dir)

    expect(resolved.entries).toEqual([
      { key: 'cache', file: 'config/cache.ts', config: { default: 'memory' }, read: ['CACHE_STORE'] },
    ])
    expect(resolved.choices.get('CACHE_STORE')).toEqual(['memory', 'redis'])
    expect(resolved.envProblem).toBeUndefined()
  })

  test('reports why a file yielded no config, without failing the others', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': ENV_SCHEMA,
      'config/cache.ts': CACHE_CONFIG,
      'config/broken.ts': `throw new Error('boom')\n`,
      'config/notes.ts': 'export const note = 1\n',
      'config/throws.ts': `import { defineConfig } from '@guren/core'

export default defineConfig({
  key: 'mail',
  resolve: () => { throw new Error('no mailer') },
  bind: () => {},
})
`,
    })

    const resolved = await loadResolvedConfig(workspace.dir)

    expect(resolved.entries.map((entry) => [entry.file, entry.key, entry.problem])).toEqual([
      ['config/broken.ts', 'broken', expect.stringContaining('failed to import: boom')],
      ['config/cache.ts', 'cache', undefined],
      ['config/notes.ts', 'notes', 'does not default-export a config definition'],
      ['config/throws.ts', 'mail', 'resolve() threw: no mailer'],
    ])
  })

  test('resolves against an empty env when config/env.ts cannot be read, and never reports itself', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': 'export default 1\n', 'config/cache.ts': CACHE_CONFIG })

    const resolved = await loadResolvedConfig(workspace.dir)

    expect(resolved.entries.map((entry) => entry.file)).toEqual(['config/cache.ts'])
    expect(resolved.entries[0].config).toEqual({ default: undefined })
    expect(resolved.envProblem).toBe('config/env.ts does not default-export a defineEnv() schema.')
  })

  test('contributes nothing when the app has no config directory', async () => {
    expect(await loadResolvedConfig(workspace.dir)).toEqual({ entries: [], choices: new Map() })
  })

  test('reads an app root other than the working directory', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'app-root/config/env.ts': ENV_SCHEMA, 'app-root/config/cache.ts': CACHE_CONFIG })
    await linkWorkspaceCore(`${workspace.dir}/app-root`)

    const resolved = await loadResolvedConfig(`${workspace.dir}/app-root`)

    expect(resolved.entries.map((entry) => entry.key)).toEqual(['cache'])
  })
})
