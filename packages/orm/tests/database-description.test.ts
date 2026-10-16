import { describe, expect, it } from 'bun:test'

import { describeServerDatabase, describeSqliteDatabase } from '../src/database-description'
import { createPostgresDatabase } from '../src/postgres'
import { createSqliteDatabase } from '../src/sqlite'

describe('describeServerDatabase', () => {
  it('reads a loopback host as local, in any case', () => {
    expect(describeServerDatabase('postgres', 'postgres://guren:guren@localhost:54322/guren', undefined).location).toBe('local')
    expect(describeServerDatabase('postgres', 'postgres://u@127.0.0.1/db', undefined).location).toBe('local')
    expect(describeServerDatabase('postgres', 'postgres://u@LOCALHOST/db', undefined).location).toBe('local')
    expect(describeServerDatabase('mysql', 'mysql://u@[::1]:3306/db', undefined).location).toBe('local')
  })

  it('reads any other host as remote, never printing the connection string', () => {
    const description = describeServerDatabase('postgres', 'postgres://u:secret@db.example.com/app', undefined)
    expect(description).toEqual({ dialect: 'postgres', location: 'remote', reason: 'The database host db.example.com is not a loopback address.' })
    expect(JSON.stringify(description)).not.toContain('secret')
    expect(describeServerDatabase('postgres', 'postgres://u@localhost.example.com/app', undefined).location).toBe('remote')
  })

  it('is unknown, never local, for what it cannot show', () => {
    expect(describeServerDatabase('postgres', undefined, undefined).location).toBe('unknown')
    expect(describeServerDatabase('postgres', '[REDACTED]', undefined).location).toBe('unknown')
    expect(describeServerDatabase('postgres', 'postgres://u:[REDACTED]@localhost/app', undefined).location).toBe('unknown')
    expect(describeServerDatabase('postgres', 'not a url', undefined).location).toBe('unknown')
    expect(describeServerDatabase('postgres', 'postgres://u@localhost/app?host=/var/run/postgresql', undefined).location).toBe('unknown')
  })

  it('reads only client options known not to move the endpoint', () => {
    expect(describeServerDatabase('postgres', 'postgres://u@localhost/app', { max: 5, ssl: true }).location).toBe('local')
    expect(describeServerDatabase('mysql', 'mysql://u@localhost/app', { connectionLimit: 5, timezone: 'Z' }).location).toBe('local')
    for (const options of [{ host: 'db.example.com' }, { socketPath: '/tmp/mysql.sock' }, { uri: 'mysql://u@db.example.com/app' }, { stream: () => null }]) {
      expect(describeServerDatabase('mysql', 'mysql://u@localhost/app', options).location).toBe('unknown')
    }
    expect(describeServerDatabase('postgres', 'postgres://u@localhost/app', { socket: () => null }).reason).toBe('The client options set `socket`, which may choose the endpoint.')
  })

  it('reads mysql2 query keys as client options, and only an endpoint key in a postgres query', () => {
    expect(describeServerDatabase('mysql', 'mysql://u@localhost/app?socketPath=/tmp/mysql.sock', undefined).location).toBe('unknown')
    expect(describeServerDatabase('mysql', 'mysql://u@localhost/app?charset=utf8mb4', undefined).location).toBe('local')
    expect(describeServerDatabase('postgres', 'postgres://u@localhost/app?sslmode=require', undefined).location).toBe('local')
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
})

describe('factory describe()', () => {
  it('resolves the SQLite filename for the given context without connecting', () => {
    const database = createSqliteDatabase({
      migrationsFolder: './missing-migrations',
      filename: (context) => (context?.env as { DATABASE_URL?: string } | undefined)?.DATABASE_URL,
    })
    expect(database.describe({ env: { DATABASE_URL: 'postgres://db.example.com/app' } }).location).toBe('unknown')
    expect(database.describe({ env: { DATABASE_URL: './data/test.db' } }).location).toBe('local')
  })

  it('resolves the Postgres connection string for the given context and judges its client options', () => {
    const resolver = (context?: { env: object }) => (context?.env as { DATABASE_URL?: string } | undefined)?.DATABASE_URL
    const database = createPostgresDatabase({ migrationsFolder: './missing-migrations', connectionString: resolver })
    expect(database.describe({ env: { DATABASE_URL: 'postgres://u@db.example.com/app' } }).location).toBe('remote')
    expect(database.describe({ env: { DATABASE_URL: 'postgres://u@localhost/app' } }).location).toBe('local')
    const overridden = createPostgresDatabase({ migrationsFolder: './missing-migrations', connectionString: 'postgres://u@localhost/app', clientOptions: { host: 'db.example.com' } })
    expect(overridden.describe().location).toBe('unknown')
  })
})
