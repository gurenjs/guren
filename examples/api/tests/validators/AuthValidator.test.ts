import { describe, expect, it } from 'vitest'
import { CreateTokenSchema, RegisterSchema } from '../../app/Http/Validators/AuthValidator.js'

describe('AuthValidator', () => {
  it('validates registration payloads', () => {
    const result = RegisterSchema.safeParse({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'password123',
    })

    expect(result.success).toBe(true)
  })

  it('defaults token abilities to wildcard', () => {
    const result = CreateTokenSchema.parse({ name: 'cli' })
    expect(result.abilities).toEqual(['*'])
  })
})
