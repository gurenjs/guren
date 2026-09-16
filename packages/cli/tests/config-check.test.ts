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

  test('contributes nothing to an app with no entry', async () => {
    const results = await run(WITH_CACHE)

    expect(results).toEqual([])
  })
})
