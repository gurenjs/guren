import { describe, expect, test } from 'bun:test'

import { databaseRefusal } from '../src/browser-serve'

describe('databaseRefusal', () => {
  test('lets a local database through', () => {
    expect(databaseRefusal({ status: 'described', value: { dialect: 'sqlite', location: 'local' } })).toBeUndefined()
  })

  test('refuses a remote or unknown database, naming the reason and the remedy', () => {
    const remote = databaseRefusal({ status: 'described', value: { dialect: 'postgres', location: 'remote', reason: 'The database host db.example.com is not a loopback address.' } })
    expect(remote).toContain('postgres database is remote, not local. The database host db.example.com')
    expect(remote).toContain('--database-url')
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
