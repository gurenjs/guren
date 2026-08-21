import { describe, expect, test } from 'bun:test'
import { ulid } from '../src/attachments/ulid'

describe('ulid', () => {
  test('should produce 26-character Crockford base32 ids', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test('should be unique and monotonic within one process', () => {
    // hasMany collections sort on the id, so ids minted in the same
    // millisecond must still order by insertion (the spec's monotonic mode).
    const ids = Array.from({ length: 2000 }, () => ulid())
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  test('should not order backwards when the clock steps back', () => {
    const later = ulid(Date.now() + 1000)
    const afterStep = ulid(Date.now() - 1000)
    expect(afterStep > later).toBe(true)
  })
})
