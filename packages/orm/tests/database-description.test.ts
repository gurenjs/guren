import { describe, expect, it } from 'bun:test'

import { describeServerDatabase, describeSqliteDatabase } from '../src/database-description'
import { createSqliteDatabase } from '../src/sqlite'

describe('describeServerDatabase', () => {
  it('reads a loopback host as local', () => {
    for (const url of ['postgres://guren:guren@localhost:54322/guren', 'postgres://u@127.0.0.1/db', 'mysql://u@[::1]:3306/db']) {
      expect(describeServerDatabase('postgres', url, undefined).location).toBe('local')
    }
  })

  it('reads any other host as remote, never printing the connection string', () => {
    const description = describeServerDatabase('postgres', 'postgres://u:secret@db.example.com/app', undefined)
    expect(description).toEqual({ dialect: 'postgres', location: 'remote', reason: 'The database host db.example.com is not a loopback address.' })
    expect(JSON.stringify(description)).not.toContain('secret')
  })

  it('is unknown, never local, for what it cannot show', () => {
    expect(describeServerDatabase('postgres', undefined, undefined).location).toBe('unknown')
    expect(describeServerDatabase('postgres', '[REDACTED]', undefined).location).toBe('unknown')
    expect(describeServerDatabase('postgres', 'not a url', undefined).location).toBe('unknown')
    expect(describeServerDatabase('postgres', 'postgres://u@localhost/app?host=/var/run/postgresql', undefined).location).toBe('unknown')
    expect(describeServerDatabase('mysql', 'mysql://u@localhost/app', { host: 'db.example.com' }).location).toBe('unknown')
    expect(describeServerDatabase('mysql', 'mysql://u@localhost/app', { socketPath: '/tmp/mysql.sock' }).location).toBe('unknown')
  })
})

describe('describeSqliteDatabase', () => {
  it('reads a file or memory database as local', () => {
    expect(describeSqliteDatabase(() => './data/guren.db')).toEqual({ dialect: 'sqlite', location: 'local' })
    expect(describeSqliteDatabase(() => ':memory:').location).toBe('local')
  })

  it('is unknown for the env placeholder and for a filename that refuses', () => {
    expect(describeSqliteDatabase(() => '[REDACTED]').location).toBe('unknown')
    const refused = describeSqliteDatabase(() => { throw new Error('postgres://u:secret@db.example.com/app is a connection URI') })
    expect(refused.location).toBe('unknown')
    expect(JSON.stringify(refused)).not.toContain('secret')
  })

  it('resolves the factory\'s filename for the given context without connecting', () => {
    const database = createSqliteDatabase({
      migrationsFolder: './missing-migrations',
      filename: (context) => (context?.env as { DATABASE_URL?: string } | undefined)?.DATABASE_URL,
    })
    expect(database.describe({ env: { DATABASE_URL: 'postgres://db.example.com/app' } }).location).toBe('unknown')
    expect(database.describe({ env: { DATABASE_URL: './data/test.db' } }).location).toBe('local')
  })
})
