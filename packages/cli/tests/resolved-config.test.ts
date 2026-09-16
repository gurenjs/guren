import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadResolvedConfig } from '../src/resolved-config'
import {
  CACHE_CONFIG_FIXTURE,
  CONFIG_ENV_FIXTURE,
  createTempWorkspace,
  linkWorkspaceCore,
  writeWorkspaceFiles,
  type TempWorkspace,
} from './helpers'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-resolved-config-')
  await linkWorkspaceCore(workspace.dir)
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('loadResolvedConfig', () => {
  test('resolves each definition against the validated env', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': CONFIG_ENV_FIXTURE, 'config/cache.ts': CACHE_CONFIG_FIXTURE })

    const resolved = await loadResolvedConfig(workspace.dir)

    expect(resolved.entries).toEqual([{ key: 'cache', file: 'config/cache.ts', config: { default: 'memory' } }])
  })

  test('does not import a module that does not read as a definition, unless the entry wired it', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': CONFIG_ENV_FIXTURE,
      'config/cache.ts': CACHE_CONFIG_FIXTURE,
      'config/inertia.ts': `throw new Error('side effect ran')\n`,
    })

    expect((await loadResolvedConfig(workspace.dir)).entries.map((entry) => entry.file)).toEqual(['config/cache.ts'])

    const wired = await loadResolvedConfig(workspace.dir, new Set(['config/inertia.ts']))
    expect(wired.entries.map((entry) => [entry.file, entry.problem])).toEqual([
      ['config/cache.ts', undefined],
      ['config/inertia.ts', 'import-failed'],
    ])
    expect(wired.entries[1].detail).toContain('side effect ran')
  })

  test('names a wired file whose default export is not a definition', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': CONFIG_ENV_FIXTURE,
      'config/plain.ts': 'export default { hello: 1 }\n',
    })

    const resolved = await loadResolvedConfig(workspace.dir, new Set(['config/plain.ts']))

    expect(resolved.entries).toEqual([{
      key: 'plain',
      file: 'config/plain.ts',
      problem: 'not-a-definition',
      detail: 'does not default-export a config definition',
    }])
  })

  test('redacts a declared secret out of the reason a resolve() threw', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': `import { defineEnv, Env } from '@guren/core'\n\nexport default defineEnv({\n  MAIL_TOKEN: Env.string().secret().default('hunter2'),\n})\n`,
      'config/mail.ts': `import { defineConfig } from '@guren/core'\n\nexport default defineConfig({\n  key: 'mail',\n  resolve: (env) => { throw new Error(\`rejected token \${env.MAIL_TOKEN}\`) },\n  bind: () => {},\n})\n`,
    })

    const [entry] = (await loadResolvedConfig(workspace.dir)).entries

    expect(entry.problem).toBe('resolve-threw')
    expect(entry.detail).toBe('resolve() threw: rejected token [REDACTED]')
  })

  test('marks a config built from an unset key as unverified rather than real', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': `import { defineEnv, Env } from '@guren/core'\n\nexport default defineEnv({\n  RFC27_ABSENT_STORE: Env.string(),\n})\n`,
      'config/cache.ts': `import { defineConfig } from '@guren/core'\n\nexport default defineConfig({\n  key: 'cache',\n  resolve: (env) => ({ default: env.RFC27_ABSENT_STORE }),\n  bind: () => {},\n})\n`,
    })

    const [entry] = (await loadResolvedConfig(workspace.dir)).entries

    expect([entry.problem, entry.detail, entry.config]).toEqual([
      'unverified-env',
      'reads RFC27_ABSENT_STORE, which the environment does not set',
      undefined,
    ])
  })

  test('never claims a config is real when the schema itself could not be read', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': 'export default 1\n', 'config/cache.ts': CACHE_CONFIG_FIXTURE })

    const [entry] = (await loadResolvedConfig(workspace.dir)).entries

    expect([entry.file, entry.problem, entry.detail]).toEqual([
      'config/cache.ts',
      'unverified-env',
      'the environment could not be validated',
    ])
  })

  test('contributes nothing when the app has no config directory', async () => {
    expect(await loadResolvedConfig(workspace.dir)).toEqual({ entries: [] })
  })

  test('reads an app root other than the working directory', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'app-root/config/env.ts': CONFIG_ENV_FIXTURE,
      'app-root/config/cache.ts': CACHE_CONFIG_FIXTURE,
    })
    await linkWorkspaceCore(`${workspace.dir}/app-root`)

    const resolved = await loadResolvedConfig(`${workspace.dir}/app-root`)

    expect(resolved.entries.map((entry) => entry.key)).toEqual(['cache'])
  })
})
