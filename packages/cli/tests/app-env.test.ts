import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkEnvExample,
  declareEnvEntries,
  envEntrySchemaSource,
  envExampleEntries,
  loadEnvSchema,
  writeEnvExample,
} from '../src/app-env'
import { assertEnvEntriesAllowed, type GurenPluginEnvEntry } from '../src/plugin-manifest'
import { createTempWorkspace, linkWorkspaceCore, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const ENV_SCHEMA = `import { defineEnv, Env } from '@guren/core'

export default defineEnv({
  APP_KEY: Env.string().secret().default('never-written'),
  APP_URL: Env.url().requiredInProduction().describe('Public base URL.'),
  SESSION_DRIVER: Env.enum(['database', 'cookie']).default('database'),
  SMTP_PORT: Env.port().default(587),
  MAIL_FROM_NAME: Env.string().allowEmpty().default('Guren App'),
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

describe('loadEnvSchema', () => {
  test('reads how each variable was declared from the imported schema', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': ENV_SCHEMA })

    const schema = await loadEnvSchema(workspace.dir)

    if (schema.status !== 'loaded') throw new Error(`expected a loaded schema, got ${schema.status}`)
    expect(Object.keys(schema.vars)).toEqual(['APP_KEY', 'APP_URL', 'SESSION_DRIVER', 'SMTP_PORT', 'MAIL_FROM_NAME'])
    expect(schema.vars.SESSION_DRIVER.choices).toEqual(['database', 'cookie'])
    expect(schema.vars.APP_URL.presence).toBe('production')
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

describe('envExampleEntries', () => {
  test('writes the default, leaves a secret blank, and lists enum choices beside the description', () => {
    const entries = envExampleEntries({
      SESSION_DRIVER: { type: 'enum', presence: 'defaulted', defaultValue: 'database', choices: ['database', 'cookie'], isSecret: false, description: 'Session store' },
      APP_KEY: { type: 'string', presence: 'defaulted', defaultValue: 'dev-key', isSecret: true },
      MAIL_FROM_NAME: { type: 'string', presence: 'defaulted', defaultValue: "O'Brien & ${APP_NAME}", isSecret: false },
    })

    expect(entries).toEqual([
      { key: 'SESSION_DRIVER', value: 'database', comment: 'Session store (one of: database, cookie)' },
      { key: 'APP_KEY', value: '' },
      { key: 'MAIL_FROM_NAME', value: '"O\'Brien & ${APP_NAME}"' },
    ])
  })
})

describe('writeEnvExample', () => {
  test('appends the keys .env.example lacks, keeps its own lines, and leaves .env alone', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': ENV_SCHEMA,
      '.env.example': 'APP_URL=http://localhost:3333\nLEGACY_FLAG=1\n',
      '.env': 'APP_URL=http://localhost:3333\n',
    })
    const schema = await loadEnvSchema(workspace.dir)
    if (schema.status !== 'loaded') throw new Error('expected a loaded schema')

    const result = await writeEnvExample(workspace.dir, schema.vars)

    expect(result).toEqual({ added: ['APP_KEY', 'SESSION_DRIVER', 'SMTP_PORT', 'MAIL_FROM_NAME'], undeclared: ['LEGACY_FLAG'] })
    expect(await readFile(join(workspace.dir, '.env.example'), 'utf8')).toBe(
      'APP_URL=http://localhost:3333\n'
      + 'LEGACY_FLAG=1\n'
      + 'APP_KEY=\n'
      + '# One of: database, cookie\n'
      + 'SESSION_DRIVER=database\n'
      + 'SMTP_PORT=587\n'
      + "MAIL_FROM_NAME='Guren App'\n",
    )
    expect(await readFile(join(workspace.dir, '.env'), 'utf8')).toBe('APP_URL=http://localhost:3333\n')
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
      '.env.example': 'APP_KEY=\nAPP_URL=\nSESSION_DRIVER=database\n# SMTP_HOST=commented out\nSMTP_PORT=587\nMAIL_FROM_NAME=Guren\n',
    })

    expect((await checkEnvExample(workspace.dir)).map((result) => result.status)).toEqual(['pass'])
  })

  test('fails naming the keys each side lacks, and points a missing key at env:example', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'config/env.ts': ENV_SCHEMA,
      '.env.example': 'APP_KEY=\nAPP_URL=\nSESSION_DRIVER=database\nSMTP_PORT=587\nLEGACY_FLAG=1\n',
    })

    const [result] = await checkEnvExample(workspace.dir)

    expect(result).toMatchObject({
      key: 'env-example',
      status: 'fail',
      message: '.env.example is missing MAIL_FROM_NAME; config/env.ts does not declare LEGACY_FLAG.',
      suggestion: 'Run `bunx guren env:example` to append the missing keys.',
      filePath: '.env.example',
    })
  })
})

describe('plugin manifest env declarations', () => {
  test('envEntrySchemaSource writes the builder chain, escaping manifest text as a string literal', () => {
    expect(envEntrySchemaSource({ key: 'ACME_REGION', type: 'enum', choices: ['us', "eu'west"], default: 'us', comment: 'Region "code"' }))
      .toBe(`Env.enum(['us', 'eu\\'west']).default('us').describe('Region "code"')`)
    expect(envEntrySchemaSource({ key: 'ACME_TOKEN', secret: true })).toBe('Env.string().optional().secret()')
    expect(envEntrySchemaSource({ key: 'ACME_PORT', type: 'port', required: true })).toBe('Env.port()')
    expect(envEntrySchemaSource({ key: 'ACME_RETRIES', type: 'number', required: true, default: 3 })).toBe('Env.number().default(3)')
  })

  test.each<[GurenPluginEnvEntry, string]>([
    [{ key: 'ACME_CHECK', type: 'custom' as never }, 'type must be one of string, url, number, port, boolean, enum.'],
    [{ key: 'ACME_MODE', type: 'enum' }, 'type "enum" needs a non-empty choices array of strings.'],
    [{ key: 'ACME_MODE', choices: ['a'] }, 'choices applies to type "enum" only.'],
    [{ key: 'ACME_PORT', type: 'port', default: '587' }, 'default must be a number for type "port".'],
    [{ key: 'ACME_MODE', type: 'enum', choices: ['a', 'b'], default: 'c' }, 'default must be one of its choices.'],
  ])('assertEnvEntriesAllowed refuses %o before anything is installed', (entry, reason) => {
    expect(() => assertEnvEntriesAllowed([entry])).toThrow(`Invalid env entry "${entry.key}": ${reason}`)
  })

  test('declareEnvEntries adds the keys in manifest order, imports Env, and yields a schema that loads', async () => {
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

    const schema = await loadEnvSchema(workspace.dir)
    if (schema.status !== 'loaded') throw new Error(`expected the patched schema to load, got ${schema.status}`)
    expect(schema.vars.ACME_TOKEN.isSecret).toBe(true)

    expect(await declareEnvEntries(entries)).toEqual({ updated: false, unpatched: [] })
  })

  test('declareEnvEntries leaves an app without config/env.ts alone, and names keys it could not place', async () => {
    const entries: GurenPluginEnvEntry[] = [{ key: 'ACME_TOKEN' }]
    expect(await declareEnvEntries(entries)).toEqual({ updated: false, unpatched: [] })

    await writeWorkspaceFiles(workspace.dir, { 'config/env.ts': 'export default schema\n' })
    expect(await declareEnvEntries(entries)).toEqual({ updated: false, unpatched: ['ACME_TOKEN'] })
  })
})
