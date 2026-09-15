import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { checkConfigWiring } from '../src/config-check'
import { ParseCache } from '../src/parse-cache'
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
  await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': ENV_SCHEMA, 'config/cache.ts': CACHE_CONFIG, ...files })
  return checkConfigWiring({ cwd: workspace.dir, cache: new ParseCache() })
}

describe('checkConfigWiring', () => {
  test('passes a definition the entry lists in createApp({ config })', async () => {
    const results = await run({ 'src/app.ts': entry('{ config: [cache] }') })

    expect(results.map((result) => [result.key, result.status])).toEqual([['config-wired:config/cache.ts', 'pass']])
  })

  test('warns about a definition no config array lists, since nothing reads it', async () => {
    const results = await run({ 'src/app.ts': entry('{ providers: [] }', '') })

    expect(results).toEqual([expect.objectContaining({
      key: 'config-unwired:config/cache.ts',
      status: 'warn',
      message: 'config/cache.ts declares the "cache" config, but src/app.ts does not list it in createApp({ config }). Nothing reads it, so the defaults apply instead.',
      filePath: 'config/cache.ts',
    })])
  })

  test('fails a listed file that is not a definition, which the boot would die on', async () => {
    const results = await run({
      'config/notes.ts': 'export const note = 1\n',
      'src/app.ts': entry('{ config: [cache, notes] }', `import cache from '../config/cache'\nimport notes from '../config/notes'\n`),
    })

    expect(results.map((result) => [result.key, result.status])).toEqual([
      ['config-wired:config/cache.ts', 'pass'],
      ['config-not-a-definition:config/notes.ts', 'fail'],
    ])
    expect(results[1].message).toContain('does not default-export a config definition')
  })

  test('says nothing about a plain module the config array never lists', async () => {
    const results = await run({
      'config/database.ts': 'export function configureOrm() {}\n',
      'src/app.ts': entry('{ config: [cache] }'),
    })

    expect(results.map((result) => result.key)).toEqual(['config-wired:config/cache.ts'])
  })

  test('reads the @/ alias and an entry at the project root', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'app.ts': `import { createApp } from '@guren/core'\nimport cache from '@/config/cache'\n\nconst app = createApp({ config: [cache] })\n\nexport default app\n`,
    })

    const results = await run({})

    expect(results.map((result) => [result.key, result.status])).toEqual([['config-wired:config/cache.ts', 'pass']])
  })

  test('judges nothing when the config array is not a literal', async () => {
    const results = await run({ 'src/app.ts': entry('{ config: definitions }', `import { definitions } from '../config/all'\n`) })

    expect(results).toEqual([])
  })

  test('contributes nothing to an app with no entry', async () => {
    const results = await run({})

    expect(results).toEqual([])
  })
})
