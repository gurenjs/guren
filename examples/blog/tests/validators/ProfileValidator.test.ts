import { describe, expect, it } from 'vitest'
import { ProfileUpdateSchema } from '../../app/Http/Validators/ProfileValidator.js'

describe('ProfileUpdateSchema', () => {
  it('requires matching passwords when provided', () => {
    const result = ProfileUpdateSchema.safeParse({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'password123',
      passwordConfirmation: 'mismatch',
    })

    expect(result.success).toBe(false)
  })

  it('omits empty passwords in the payload', () => {
    const result = ProfileUpdateSchema.parse({
      name: 'Ada',
      email: 'ada@example.com',
      password: '',
      passwordConfirmation: '',
    })

    expect(result.password).toBeUndefined()
  })
})
