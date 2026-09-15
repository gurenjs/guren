import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkEnvExample, declareEnvEntries, loadEnvSchema, writeEnvExample } from '../src/app-env'
import type { GurenPluginEnvEntry } from '../src/plugin-manifest'
import { createTempWorkspace, linkWorkspaceCore, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const ENV_SCHEMA = `import { defineEnv, Env } from '@guren/core'

export default defineEnv({
  APP_KEY: Env.string().secret().default('never-written'),
  APP_URL: Env.url().requiredInProduction().describe('Public base URL.\\nProduction host authorization answers only to its hostname.'),
  SESSION_DRIVER: Env.enum(['database', 'cookie']).default('database').describe('Session store'),
  SMTP_PORT: Env.port().default(587),
  MAIL_FROM_NAME: Env.string().allowEmpty().default('Guren App'),
  MAIL_SIGNATURE: Env.string().default('Pay $5 "now"'),
})
`

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-app-env-')
  await linkWorkspaceCore(workspace.dir)
})

afterEach(async () => {
  await workspace.cleanup()
})

async function loadedVars() {
  const schema = await loadEnvSchema(workspace.dir)
  if (schema.status !== 'loaded') throw new Error(`expected a loaded schema, got ${JSON.stringify(schema)}`)
  return schema.vars
}

describe('loadEnvSchema', () => {
  test('reads each declared variable from the imported schema', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': ENV_SCHEMA })

    const vars = await loadedVars()

    expect(Object.keys(vars)).toEqual(['APP_KEY', 'APP_URL', 'SESSION_DRIVER', 'SMTP_PORT', 'MAIL_FROM_NAME', 'MAIL_SIGNATURE'])
    expect([vars.SESSION_DRIVER.choices, vars.SMTP_PORT.defaultValue]).toEqual([['database', 'cookie'], 587])
  })

  test('is absent without config/env.ts, and unreadable when it exports no schema', async () => {
    expect(await loadEnvSchema(workspace.dir)).toEqual({ status: 'absent' })

    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': 'export default { APP_KEY: "x" }\n' })
    expect(await loadEnvSchema(workspace.dir)).toEqual({
      status: 'unreadable',
      message: 'config/env.ts does not default-export a defineEnv() schema.',
    })
  })
})

describe('writeEnvExample', () => {
  test('appends the keys .env.example lacks, keeps its own lines, and leaves .env alone', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': ENV_SCHEMA,
      '.env.example': 'export LEGACY_FLAG=1\nexport SMTP_PORT=2525\n',
      '.env': 'APP_URL=http://localhost:3333\n',
    })

    const result = await writeEnvExample(workspace.dir, await loadedVars())

    expect(result).toEqual({ added: ['APP_KEY', 'APP_URL', 'SESSION_DRIVER', 'MAIL_FROM_NAME', 'MAIL_SIGNATURE'], undeclared: ['LEGACY_FLAG'] })
    expect(await readFile(join(workspace.dir, '.env.example'), 'utf8')).toBe(
      'export LEGACY_FLAG=1\n'
      + 'export SMTP_PORT=2525\n'
      + 'APP_KEY=\n'
      + '# Public base URL.\n'
      + '# Production host authorization answers only to its hostname.\n'
      + 'APP_URL=\n'
      + '# Session store (one of: database, cookie)\n'
      + 'SESSION_DRIVER=database\n'
      + 'MAIL_FROM_NAME="Guren App"\n'
      + 'MAIL_SIGNATURE=\'Pay \\$5 "now"\'\n',
    )
    expect(await readFile(join(workspace.dir, '.env'), 'utf8')).toBe('APP_URL=http://localhost:3333\n')
  })

  test('writes values Bun loads back as the declared defaults', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': ENV_SCHEMA })
    await writeEnvExample(workspace.dir, await loadedVars())

    const keys = ['SESSION_DRIVER', 'SMTP_PORT', 'MAIL_FROM_NAME', 'MAIL_SIGNATURE']
    const probe = Bun.spawnSync(
      ['bun', '--env-file=.env.example', '-e', `console.log(JSON.stringify(${JSON.stringify(keys)}.map((key) => process.env[key])))`],
      { cwd: workspace.dir, env: { PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe' },
    )

    expect(probe.stderr.toString()).toBe('')
    expect(JSON.parse(probe.stdout.toString())).toEqual(['database', '587', 'Guren App', 'Pay $5 "now"'])
  })
})

describe('checkEnvExample', () => {
  test('contributes nothing to an app without config/env.ts', async () => {
    await writeWorkspaceFiles(workspace.dir, { '.env.example': 'APP_URL=\n' })

    expect(await checkEnvExample(workspace.dir)).toEqual([])
  })

  test('passes when .env.example assigns exactly the declared keys', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': ENV_SCHEMA,
      '.env.example': 'APP_KEY=\nAPP_URL=\nSESSION_DRIVER=database\n# SMTP_HOST=commented out\nSMTP_PORT=587\nMAIL_FROM_NAME=Guren\nMAIL_SIGNATURE=\n',
    })

    expect((await checkEnvExample(workspace.dir)).map((result) => result.status)).toEqual(['pass'])
  })

  test('fails naming the keys each side lacks, and points a missing key at env:example', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': ENV_SCHEMA,
      '.env.example': 'APP_KEY=\nAPP_URL=\nSESSION_DRIVER=database\nSMTP_PORT=587\nMAIL_SIGNATURE=\nLEGACY_FLAG=1\n',
    })

    expect(await checkEnvExample(workspace.dir)).toEqual([expect.objectContaining({
      key: 'env-example',
      status: 'fail',
      message: '.env.example is missing MAIL_FROM_NAME; config/env.ts does not declare LEGACY_FLAG.',
      suggestion: 'Run `bunx guren env:example` to append the missing keys.',
      filePath: '.env.example',
    })])
  })

  test('fails when config/env.ts cannot be read, rather than passing a comparison it never made', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': 'export default 1\n', '.env.example': '' })

    expect((await checkEnvExample(workspace.dir)).map((result) => [result.status, result.filePath])).toEqual([['fail', 'config/env.ts']])
  })
})

describe('declareEnvEntries', () => {
  test('adds the keys in manifest order, imports Env, and yields a schema that loads', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': `import { defineEnv } from '@guren/core'\n\nexport default defineEnv({\n  APP_KEY: Env.string(),\n})\n`,
    })
    const entries: GurenPluginEnvEntry[] = [
      { key: 'ACME_TOKEN', secret: true, comment: 'Acme API token' },
      { key: 'ACME_REGION', type: 'enum', choices: ['us', 'eu'], default: 'us' },
      { key: 'APP_KEY', type: 'url' },
    ]

    expect(await declareEnvEntries(entries)).toEqual({ updated: true, unpatched: [] })
    expect(await readFile(join(workspace.dir, 'config/env.ts'), 'utf8')).toBe(
      `import { Env, defineEnv } from '@guren/core'\n\nexport default defineEnv({\n`
      + `  ACME_TOKEN: Env.string().optional().secret().describe('Acme API token'),\n`
      + `  ACME_REGION: Env.enum(['us', 'eu']).default('us'),\n`
      + `  APP_KEY: Env.string(),\n})\n`,
    )
    expect((await loadedVars()).ACME_TOKEN.isSecret).toBe(true)

    expect(await declareEnvEntries(entries)).toEqual({ updated: false, unpatched: [] })
  })

  test('leaves an app without config/env.ts alone, and names keys it could not place', async () => {
    const entries: GurenPluginEnvEntry[] = [{ key: 'ACME_TOKEN' }]
    expect(await declareEnvEntries(entries)).toEqual({ updated: false, unpatched: [] })

    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': 'export default schema\n' })
    expect(await declareEnvEntries(entries)).toEqual({ updated: false, unpatched: ['ACME_TOKEN'] })
  })
})
