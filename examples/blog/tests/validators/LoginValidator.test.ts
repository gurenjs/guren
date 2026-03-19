import { describe, expect, it } from 'vitest'
import { LoginSchema } from '../../app/Http/Validators/LoginValidator.js'

describe('LoginSchema', () => {
  it('coerces remember values to boolean', () => {
    const result = LoginSchema.parse({
      email: 'test@example.com',
      password: 'secret',
      remember: 'on',
    })

    expect(result.remember).toBe(true)
  })
})
