import { describe, expect, it } from 'bun:test'
import { pgTable, sql } from '../src/drizzle'

describe('drizzle re-exports', () => {
  it('exposes drizzle helpers', () => {
    expect(typeof sql).toBe('function')
    expect(typeof pgTable).toBe('function')
  })
})
