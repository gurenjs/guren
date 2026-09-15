import { describe, expect, test } from 'bun:test'
import { envEntrySchemaSource } from '../src/plugin-env'
import { assertEnvEntriesAllowed, type GurenPluginEnvEntry } from '../src/plugin-manifest'

describe('plugin manifest env declarations', () => {
  test.each<[GurenPluginEnvEntry, string]>([
    [
      { key: 'ACME_REGION', type: 'enum', choices: ['us', "eu'west"], default: 'us', comment: 'Region "code"' },
      `Env.enum(['us', 'eu\\'west']).default('us').describe('Region "code"')`,
    ],
    [{ key: 'ACME_TOKEN', secret: true }, 'Env.string().optional().secret()'],
    [{ key: 'ACME_PORT', type: 'port', required: true }, 'Env.port()'],
    [{ key: 'ACME_RETRIES', type: 'number', required: true, default: 3 }, 'Env.number().default(3)'],
  ])('envEntrySchemaSource(%o) writes %s', (entry, source) => {
    expect(envEntrySchemaSource(entry)).toBe(source)
  })

  test.each<[GurenPluginEnvEntry, string]>([
    [{ key: 'ACME_CHECK', type: 'custom' as never }, 'type must be one of string, url, number, port, boolean, enum.'],
    [{ key: 'ACME_TOKEN', required: 'false' as never }, 'required must be true or false.'],
    [{ key: 'ACME_MODE', type: 'enum' }, 'type "enum" needs a non-empty choices array of strings.'],
    [{ key: 'ACME_MODE', choices: ['a'] }, 'choices applies to type "enum" only.'],
    [{ key: 'ACME_PORT', type: 'port', default: '587' }, 'default must be a number for type "port".'],
    [{ key: 'ACME_PORT', type: 'port', default: 70000 }, 'default must be a port (an integer from 1 to 65535).'],
    [{ key: 'ACME_MODE', type: 'enum', choices: ['a', 'b'], default: 'c' }, 'default must be one of its choices.'],
  ])('assertEnvEntriesAllowed refuses %o before anything is installed', (entry, reason) => {
    expect(() => assertEnvEntriesAllowed([entry])).toThrow(`Invalid env entry "${entry.key}": ${reason}`)
  })
})
