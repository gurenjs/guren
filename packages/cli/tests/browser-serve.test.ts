import { describe, expect, test } from 'bun:test'

import { VITE_PORT_ENV } from '../../server/src/http/vite-dev-server'
import { databaseRefusal, reportedPort, vitePortEnv } from '../src/browser-serve'

describe('databaseRefusal', () => {
  test('lets a local database through', () => {
    expect(databaseRefusal({ status: 'described', value: { dialect: 'sqlite', location: 'local' } })).toBeUndefined()
  })

  test('refuses a remote or unknown database, naming the reason and the remedy', () => {
    const remote = databaseRefusal({ status: 'described', value: { dialect: 'postgres', location: 'remote', reason: 'The database host db.example.com is not a loopback address.' } })
    expect(remote).toContain('postgres database is remote, not local. The database host db.example.com')
    expect(remote).toContain('Ask the person for a local database URL')
    expect(databaseRefusal({ status: 'described', value: { dialect: 'd1', location: 'unknown' } })).toContain('is unknown, not local')
  })

  test('refuses an unverified section, which no --database-url can fix', () => {
    const refusal = databaseRefusal({ status: 'unverified', reason: 'EncryptionServiceProvider threw in register()' })
    expect(refusal).toContain('unverified (EncryptionServiceProvider threw in register())')
    expect(refusal).toContain('guren introspect')
    expect(refusal).not.toContain('--database-url')
  })

  test('refuses an app that binds no database rather than assuming it has none', () => {
    expect(databaseRefusal({ status: 'described', value: undefined })).toContain('binds no database')
  })
})

describe('vitePortEnv', () => {
  test('hands the app the port after its own for Vite, under the name the server reads', () => {
    expect(vitePortEnv(4317, {})).toEqual({ [VITE_PORT_ENV]: '4318' })
  })

  test('keeps a Vite port the caller already chose', () => {
    expect(vitePortEnv(4317, { GUREN_VITE_PORT: '5188' })).toEqual({})
  })

  test('reads a blank GUREN_VITE_PORT as unset, as the server does', () => {
    expect(vitePortEnv(4317, { GUREN_VITE_PORT: ' ' })).toEqual({ GUREN_VITE_PORT: '4318' })
  })

  test('hands none past the last port, which the server would refuse', () => {
    expect(vitePortEnv(65535, {})).toEqual({})
    expect(vitePortEnv(65534, {})).toEqual({ GUREN_VITE_PORT: '65535' })
  })
})

describe('reportedPort', () => {
  test('reads the port from the dev banner, coloured or not', () => {
    expect(reportedPort('   \u2022 Bound address  : http://127.0.0.1:4317\n')).toBe(4317)
    expect(reportedPort('\u001b[35m   \u2022\u001b[39m \u001b[1mBound address \u001b[22m: \u001b[96mhttp://127.0.0.1:4317\u001b[39m')).toBe(4317)
  })

  test('reads nothing before the banner or for another address', () => {
    expect(reportedPort('[guren] Port 4317 is in use, trying 4318...')).toBeUndefined()
    expect(reportedPort('   \u2022 Bound address  : http://0.0.0.0:4317')).toBeUndefined()
  })
})
