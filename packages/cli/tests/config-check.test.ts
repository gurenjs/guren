import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { checkConfigWiring } from '../src/config-check'
import { ParseCache } from '../src/parse-cache'
import {
  CACHE_CONFIG_FIXTURE,
  CONFIG_ENV_FIXTURE,
  createTempWorkspace,
  linkWorkspaceCore,
  writeWorkspaceFiles,
  type TempWorkspace,
} from './helpers'

function entry(body: string, imports = `import cache from '../config/cache'\n`): string {
  return `import { createApp } from '@guren/core'
${imports}
const app = createApp(${body})

export default app
`
}

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-config-check-')
  await linkWorkspaceCore(workspace.dir)
})

afterEach(async () => {
  await workspace.cleanup()
})

async function run(files: Record<string, string>) {
  await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': CONFIG_ENV_FIXTURE, ...files })
  return checkConfigWiring({ cwd: workspace.dir, cache: new ParseCache() })
}

const WITH_CACHE = { 'config/cache.ts': CACHE_CONFIG_FIXTURE }

describe('checkConfigWiring', () => {
  test('passes once, naming how many definitions the entry lists', async () => {
    const results = await run({ ...WITH_CACHE, 'src/app.ts': entry('{ config: [cache] }') })

    expect(results.map((result) => [result.key, result.status])).toEqual([['config-wired', 'pass']])
    expect(results[0].message).toBe('src/app.ts lists 1 config definition(s) in createApp({ config }).')
  })

  test('warns about a definition no config array lists, since nothing reads it', async () => {
    const results = await run({ ...WITH_CACHE, 'src/app.ts': entry('{ providers: [] }', '') })

    expect(results).toEqual([expect.objectContaining({
      key: 'config-unwired:config/cache.ts',
      status: 'warn',
      message: 'config/cache.ts declares the "cache" config, but src/app.ts does not list it in createApp({ config }). Nothing reads it, so the defaults apply instead.',
      filePath: 'config/cache.ts',
    })])
  })

  test('fails a listed file that is not a definition, which the boot would die on', async () => {
    const results = await run({
      ...WITH_CACHE,
      'config/notes.ts': 'export default { note: 1 }\n',
      'src/app.ts': entry('{ config: [cache, notes] }', `import cache from '../config/cache'\nimport notes from '../config/notes'\n`),
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([
      ['config-wired', 'pass'],
      ['config-not-a-definition:config/notes.ts', 'fail'],
    ])
    expect(results[1].message).toContain('does not default-export a config definition')
  })

  test('warns rather than failing when a listed file cannot be imported', async () => {
    const results = await run({
      'config/cache.ts': `throw new Error('boom')\n`,
      'src/app.ts': entry('{ config: [cache] }'),
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([['config-unreadable:config/cache.ts', 'warn']])
    expect(results[0].message).toContain('failed to import: boom')
  })

  test('says nothing about a plain module the config array never lists, and never imports it', async () => {
    const results = await run({
      ...WITH_CACHE,
      'config/inertia.ts': `throw new Error('side effect ran')\n`,
      'src/app.ts': entry('{ config: [cache] }'),
    })

    expect(results.map((result) => result.key)).toEqual(['config-wired'])
  })

  test('reads the @/ alias, a directory import and an entry at the project root', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/index.ts': CACHE_CONFIG_FIXTURE,
      'app.ts': `import { createApp } from '@guren/core'\nimport cache from '@/config'\n\nconst app = createApp({ config: [cache] })\n\nexport default app\n`,
    })

    const results = await run({})

    expect(results.map((result) => [result.key, result.status])).toEqual([['config-wired', 'pass']])
  })

  test('judges nothing when an element of the config array is not an identifier', async () => {
    const results = await run({
      ...WITH_CACHE,
      'src/app.ts': entry('{ config: [cache, ...extra] }', `import cache from '../config/cache'\nimport { extra } from '../config/extra'\n`),
    })

    expect(results).toEqual([])
  })

  test('judges nothing when the config array is not a literal', async () => {
    const results = await run({ ...WITH_CACHE, 'src/app.ts': entry('{ config: definitions }', `import { definitions } from '../config/all'\n`) })

    expect(results).toEqual([])
  })

  test('names the entry as the lister of a file it lists that is not a definition', async () => {
    const results = await run({
      'config/notes.ts': 'export default { note: 1 }\n',
      'src/app.ts': entry('{ config: [notes] }', `import notes from '../config/notes'\n`),
    })

    expect(results[0]?.message).toBe('createApp({ config }) in src/app.ts lists config/notes.ts, but it does not default-export a config definition. The boot fails on it.')
  })

  test('contributes nothing to an app with no entry', async () => {
    const results = await run(WITH_CACHE)

    expect(results).toEqual([])
  })
})

const OAUTH_CONFIG = `import { defineOAuthConfig } from '@guren/core'

export default defineOAuthConfig(() => ({ providers: {} }))
`

function billingModule(options: string, imports = `import oauth from './config/oauth'\n`): string {
  return `import { defineModule } from '@guren/core'
${imports}
export const billingModule = defineModule(${options})
`
}

const MOUNTS_BILLING = `import billing from '../modules/billing'\nimport cache from '../config/cache'\n`

describe('checkConfigWiring with defineModule({ config }) (RFC 0002)', () => {
  test('passes a module definition its module lists, when createApp lists the module', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/config/oauth.ts': OAUTH_CONFIG,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', config: [oauth] }`),
      'src/app.ts': entry('{ config: [cache], modules: [billing] }', MOUNTS_BILLING),
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([['config-wired', 'pass']])
    expect(results[0].message).toBe('2 config definition(s) are listed across src/app.ts and modules/billing/index.ts.')
  })

  test('warns about a module definition nothing lists, pointing at its module', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/config/oauth.ts': OAUTH_CONFIG,
      'modules/billing/index.ts': billingModule(`{ name: 'billing' }`, ''),
      'src/app.ts': entry('{ config: [cache], modules: [billing] }', MOUNTS_BILLING),
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([
      ['config-wired', 'pass'],
      ['config-unwired:modules/billing/config/oauth.ts', 'warn'],
    ])
    expect(results[1].suggestion).toBe('Add it to defineModule({ config: [...] }) in modules/billing/index.ts.')
  })

  test('warns when the listing module is not in createApp({ modules }), since nothing reads its config', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/config/oauth.ts': OAUTH_CONFIG,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', config: [oauth] }`),
      'src/app.ts': entry('{ config: [cache] }'),
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([
      ['config-wired', 'pass'],
      ['config-unwired:modules/billing/config/oauth.ts', 'warn'],
    ])
    expect(results[1].message).toContain('createApp({ modules }) in src/app.ts does not list modules/billing')
  })

  test('counts a root config file a mounted module lists as wired', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', config: [cache] }`, `import cache from '../../config/cache'\n`),
      'src/app.ts': entry('{ modules: [billing] }', `import billing from '../modules/billing/index.js'\n`),
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([['config-wired', 'pass']])
  })

  test('fails a key the app and a module both list, which the boot refuses', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/config/cache.ts': CACHE_CONFIG_FIXTURE,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', config: [cache] }`, `import cache from './config/cache'\n`),
      'src/app.ts': entry('{ config: [cache], modules: [billing] }', MOUNTS_BILLING),
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([
      ['config-wired', 'pass'],
      ['config-duplicate-key:cache', 'fail'],
    ])
    expect(results[1].message).toBe('The "cache" config is listed 2 times: config/cache.ts by createApp({ config }) in src/app.ts, modules/billing/config/cache.ts by defineModule({ config }) in modules/billing/index.ts. The boot fails on the second.')
  })

  test('fails a duplicate key even when one side could not be resolved on this machine', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/config/cache.ts': `import { defineConfig } from '@guren/core'\n\nexport default defineConfig({ key: 'cache', resolve: () => { throw new Error('no redis') }, bind: () => {} })\n`,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', config: [cache] }`, `import cache from './config/cache'\n`),
      'src/app.ts': entry('{ config: [cache], modules: [billing] }', MOUNTS_BILLING),
    })

    expect(results.map((result) => [result.key, result.status])).toContainEqual(['config-duplicate-key:cache', 'fail'])
  })

  test('judges nothing when a module descriptor is not a defineModule() call, since it may list any file', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/config/oauth.ts': OAUTH_CONFIG,
      'modules/billing/index.ts': `import oauth from './config/oauth'\n\nexport const billing = { name: 'billing', providers: [], commands: [], config: [oauth] }\n`,
      'src/app.ts': entry('{ config: [cache], modules: [billing] }', MOUNTS_BILLING),
    })

    expect(results).toEqual([])
  })

  test('judges nothing when a module config array is not a literal, since it may list any file', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', config: definitions }`, `import { definitions } from './config/all'\n`),
      'src/app.ts': entry('{ modules: [billing] }', `import billing from '../modules/billing'\n`),
    })

    expect(results).toEqual([])
  })

  test('judges nothing when a module descriptor spreads options that may carry config', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', ...shared }`, `import { shared } from './shared'\n`),
      'src/app.ts': entry('{ modules: [billing] }', `import billing from '../modules/billing'\n`),
    })

    expect(results).toEqual([])
  })

  test('judges nothing when createApp spreads options that may carry the listing module', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/config/oauth.ts': OAUTH_CONFIG,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', config: [oauth] }`),
      'src/app.ts': entry('{ config: [cache], ...shared }', `import cache from '../config/cache'\nimport { shared } from './shared'\n`),
    })

    expect(results).toEqual([])
  })

  test('judges nothing when createApp({ modules }) cannot be traced and a module lists config', async () => {
    const results = await run({
      ...WITH_CACHE,
      'modules/billing/config/oauth.ts': OAUTH_CONFIG,
      'modules/billing/index.ts': billingModule(`{ name: 'billing', config: [oauth] }`),
      'src/app.ts': entry('{ config: [cache], modules: allModules }', `import cache from '../config/cache'\nimport { allModules } from '../modules/all'\n`),
    })

    expect(results).toEqual([])
  })
})
