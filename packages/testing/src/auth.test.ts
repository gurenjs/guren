import { describe, expect, it } from 'vitest'
import { createMockAuthContext, createMockProvider, createMockUser } from './auth'

describe('auth helpers', () => {
  it('creates a mock user with auth helpers', () => {
    const user = createMockUser({
      id: 1,
      email: 'jane@example.com',
      password: 'secret',
    })

    expect(user.getAuthIdentifier()).toBe(1)
    expect(user.getAuthPassword()).toBe('secret')
  })

  it('creates a mock provider that resolves users', async () => {
    const users = [
      createMockUser({ id: 1, email: 'a@example.com', password: 'pass-a' }),
      createMockUser({ id: 2, email: 'b@example.com', password: 'pass-b' }),
    ]
    const provider = createMockProvider(users)

    await expect(provider.retrieveById(2)).resolves.toEqual(users[1])
    await expect(provider.retrieveByCredentials({ email: 'a@example.com' })).resolves.toEqual(users[0])
    await expect(provider.validateCredentials(users[0], { password: 'pass-a' })).resolves.toBe(true)
    await expect(provider.validateCredentials(users[0], { password: 'wrong' })).resolves.toBe(false)
  })

  it('creates a mock auth context', async () => {
    const auth = createMockAuthContext({ isAuthenticated: true, user: { id: 5, name: 'Sam' } })

    await expect(auth.check()).resolves.toBe(true)
    await expect(auth.guest()).resolves.toBe(false)
    await expect(auth.user()).resolves.toEqual({ id: 5, name: 'Sam' })
    await expect(auth.id()).resolves.toBe(5)
  })
})
