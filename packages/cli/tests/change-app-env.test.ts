import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { envKeyAdditions } from '../src/change/app-env'
import { envBuilderSignature, plannedEnvSignature } from '../src/env-declarations'
import { ensureNamedImports, insertCallOptions } from '../src/patch-helpers'
import { envEntrySchemaSource } from '../src/plugin-env'
import type { GurenPluginEnvEntry } from '../src/plugin-manifest'
import { parseExpression } from '@babel/parser'

const PATH = 'config/env.ts'
const BASE = readFileSync(join(import.meta.dir, '../../create-app/templates/default/config/env.ts'), 'utf8')

/** `content` with `entries` declared as `guren plugin` declares a manifest's keys. */
function declared(content: string, entries: GurenPluginEnvEntry[]): string {
  const patched = insertCallOptions(content, entries.map((entry) => ({ key: entry.key, source: envEntrySchemaSource(entry) })), 'defineEnv')
  if (typeof patched === 'string') throw new Error(patched)
  return ensureNamedImports(patched.content, '@guren/core', ['Env'])
}

const QUEUE: GurenPluginEnvEntry = { key: 'QUEUE_CONNECTION', default: 'sync' }

describe('envKeyAdditions', () => {
  test('should read the keys a change adds to defineEnv(), with the Env import they need', () => {
    expect(envKeyAdditions(BASE, declared(BASE, [QUEUE, { key: 'QUEUE_PORT', type: 'port', default: 6379 }]), PATH)).toEqual(['QUEUE_CONNECTION', 'QUEUE_PORT'])
    const bare = "import { defineEnv } from '@guren/core'\n\nconst env = defineEnv({})\n\nexport default env\n"
    const head = declared(bare, [QUEUE])
    expect(head).toContain("import { Env, defineEnv } from '@guren/core'")
    expect(envKeyAdditions(bare, head, PATH)).toEqual(['QUEUE_CONNECTION'])
    expect(envKeyAdditions(BASE, BASE.replace('const env', '// the schema\nconst env'), PATH)).toEqual([])
  })

  test('should refuse a change to a key the base declares, and anything beyond the keys it adds', () => {
    const head = declared(BASE, [QUEUE])
    const refused = {
      'a default changed': head.replace('Env.port().default(3333)', 'Env.port().default(4000)'),
      'a key removed': head.replace(/ {2}HOST: .*\n/u, ''),
      'a key written again': head.replace("APP_NAME: Env.string().default('Guren'),", "APP_NAME: Env.string().default('Guren'),\n  'APP_NAME': Env.string(),"),
      'a key moved': head.replace(/ {2}HOST: .*\n/u, '').replace('const env = defineEnv({\n', "const env = defineEnv({\n  HOST: Env.string().default('0.0.0.0'),\n"),
      'a statement': `${head}\nconsole.log(env)\n`,
      'a spread': head.replace('const env = defineEnv({\n', 'const env = defineEnv({\n  ...shared,\n'),
      'the Env import dropped': head.replace("import { defineEnv, Env, type InferEnv } from '@guren/core'", "import { defineEnv, type InferEnv } from '@guren/core'"),
    }
    for (const [label, text] of Object.entries(refused)) expect([label, envKeyAdditions(BASE, text, PATH)]).toEqual([label, undefined])
    const local = (text: string): string => text.replace("import { defineEnv, Env, type InferEnv } from '@guren/core'", "import { Env, type InferEnv } from '@guren/core'\nconst defineEnv = (keys: object) => keys")
    expect(envKeyAdditions(local(BASE), local(head), PATH)).toBeUndefined()
  })
})

describe('envBuilderSignature', () => {
  const signature = (source: string) => envBuilderSignature(parseExpression(source) as never)

  test('should read a chain by what it declares: the builder, the last presence call, the flags, never the prose', () => {
    expect(signature("Env.string().describe('The queue driver.').default('sync')")).toBe(signature("Env.string().default('sync')"))
    expect(signature("Env.string().secret().default('x')")).toBe(signature("Env.string().default('x').secret()"))
    // The last presence call is the one that holds.
    expect(signature("Env.string().default('sync').optional()")).not.toBe(signature("Env.string().default('sync')"))
    expect(signature("Env.enum(['a', 'b'])")).not.toBe(signature("Env.enum(['b', 'a'])"))
    expect(signature("Env.string().transform((value) => value)")).toBeUndefined()
    expect(signature("Other.string()")).toBeUndefined()
  })

  test('should give a planned key the meaning of the declaration guren plugin writes for it', () => {
    expect(plannedEnvSignature(QUEUE)).toBe(signature("Env.string().default('sync')"))
    expect(plannedEnvSignature({ key: 'TOKEN', secret: true })).toBe(signature('Env.string().optional().secret()'))
    expect(plannedEnvSignature({ key: 'TOKEN', required: true })).toBe(signature('Env.string()'))
  })
})
