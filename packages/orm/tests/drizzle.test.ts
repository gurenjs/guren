import { describe, expect, it } from 'bun:test'
import { int, mysqlTable, pgTable, sql, varchar } from '../src/drizzle'

describe('drizzle re-exports', () => {
  it('exposes drizzle helpers', () => {
    expect(typeof sql).toBe('function')
    expect(typeof pgTable).toBe('function')
    expect(typeof mysqlTable).toBe('function')
    expect(typeof int).toBe('function')
    expect(typeof varchar).toBe('function')
  })
})
