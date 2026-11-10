import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthManager, Container } from '@guren/core'
import type { Context, Session } from '@guren/core'

type Row = { id: number; email: string; passwordHash: string; rememberToken: string | null }

const { rows, User } = vi.hoisted(() => {
  const rows = new Map<number, Row>()
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key as keyof Row] === value)

  // The model surface ModelUserProvider calls, over an in-memory table.
  class User {
    static hidden = ['passwordHash', 'rememberToken']
    static find = vi.fn(async (id: unknown) => {
      const row = rows.get(Number(id))
      return row ? { ...row } : null
    })
    static async where(where: Record<string, unknown>) {
      return [...rows.values()].filter((row) => matches(row, where)).map((row) => ({ ...row }))
    }
    static async forceUpdate(where: Record<string, unknown>, values: Record<string, unknown>) {
      for (const row of rows.values()) {
        if (matches(row, where)) Object.assign(row, values)
      }
    }
    static storePasswordHash = vi.fn(async (where: Record<string, unknown>, column: string, hash: string) => {
      await User.forceUpdate(where, { [column]: hash })
    })
  }

  return { rows, User }
})

vi.mock('../../../../app/Models/User.js', () => ({ User }))

import AuthProvider from '../Providers/AuthProvider.js'
import { PasswordBoundSessionGuard } from './PasswordBoundSessionGuard.js'

const OLD_FORMAT = '$scrypt$v1$'
const CURRENT_FORMAT = '$scrypt$v2$'

// Rehashes every OLD_FORMAT hash at login, as a cost or algorithm change does.
const hasher = {
  hash: async (plain: string) => `${CURRENT_FORMAT}${plain}`,
  verify: async (hashed: string, plain: string) =>
    hashed === `${OLD_FORMAT}${plain}` || hashed === `${CURRENT_FORMAT}${plain}`,
  needsRehash: (hashed: string) => !hashed.startsWith(CURRENT_FORMAT),
}

function memorySession() {
  const data = new Map<string, unknown>()
  const session = {
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => {
      data.set(key, value)
    },
    has: (key: string) => data.has(key),
    forget: (key: string) => {
      data.delete(key)
    },
    regenerate: () => {},
  }
  return { data, session: session as unknown as Session }
}

function wireAuth() {
  const manager = new AuthManager({ hasher })
  const container = new Container()
  container.instance('auth', manager)
  new AuthProvider(container).register()
  return manager
}

/** One guard per request, as the auth context builds them, over a session that outlives it. */
function requestFor(manager: AuthManager, session: Session) {
  return manager.createGuard<Row>('web', { ctx: {} as Context, session, manager })
}

function seed(passwordHash: string): void {
  rows.set(1, { id: 1, email: 'ada@example.com', passwordHash, rememberToken: null })
}

const credentials = { email: 'ada@example.com', password: 'secret' }

describe('PasswordBoundSessionGuard', () => {
  beforeEach(() => {
    rows.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is the web guard AuthProvider registers', () => {
    const manager = wireAuth()
    const { session } = memorySession()

    expect(requestFor(manager, session)).toBeInstanceOf(PasswordBoundSessionGuard)
    expect(manager.getDefaultGuard()).toBe('web')
  })

  it('keeps a session whose password has not changed', async () => {
    seed(`${CURRENT_FORMAT}secret`)
    const manager = wireAuth()
    const { session } = memorySession()

    expect(await requestFor(manager, session).attempt(credentials)).toBe(true)

    const next = requestFor(manager, session)
    expect(await next.check()).toBe(true)
    expect(await next.id()).toBe(1)
  })

  it('signs out every session once the password hash changes', async () => {
    seed(`${CURRENT_FORMAT}secret`)
    const manager = wireAuth()
    const first = memorySession()
    const second = memorySession()
    await requestFor(manager, first.session).attempt(credentials)
    await requestFor(manager, second.session).attempt(credentials)

    rows.get(1)!.passwordHash = `${CURRENT_FORMAT}new-secret`

    for (const { data, session } of [first, second]) {
      const next = requestFor(manager, session)
      expect(await next.check()).toBe(false)
      expect(await next.user()).toBeNull()
      expect(await next.id()).toBeNull()
      expect(data.has('auth:user_id')).toBe(false)
      expect(data.has('auth:password_stamp')).toBe(false)
    }
  })

  it('keeps the session when the rehash write at login fails', async () => {
    seed(`${OLD_FORMAT}secret`)
    User.storePasswordHash.mockRejectedValueOnce(new Error('write failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const manager = wireAuth()
    const { session } = memorySession()

    const login = requestFor(manager, session)
    expect(await login.attempt(credentials)).toBe(true)
    expect(await login.user()).toMatchObject({ id: 1 })
    expect(rows.get(1)?.passwordHash).toBe(`${OLD_FORMAT}secret`)

    expect(await requestFor(manager, session).check()).toBe(true)
  })

  it('stamps the rehashed value when the rehash write succeeds', async () => {
    seed(`${OLD_FORMAT}secret`)
    const manager = wireAuth()
    const { session } = memorySession()

    expect(await requestFor(manager, session).attempt(credentials)).toBe(true)
    expect(rows.get(1)?.passwordHash).toBe(`${CURRENT_FORMAT}secret`)

    expect(await requestFor(manager, session).check()).toBe(true)
  })

  it('refuses a login that a password reset overtook', async () => {
    seed(`${CURRENT_FORMAT}secret`)
    User.find.mockResolvedValueOnce({ ...rows.get(1)!, passwordHash: `${CURRENT_FORMAT}new-secret` })
    const manager = wireAuth()
    const { data, session } = memorySession()

    expect(await requestFor(manager, session).attempt(credentials)).toBe(false)
    expect(data.has('auth:user_id')).toBe(false)
  })

  it('signs out a session that carries no password stamp', async () => {
    seed(`${CURRENT_FORMAT}secret`)
    const manager = wireAuth()
    const { data, session } = memorySession()
    data.set('auth:user_id', 1)

    expect(await requestFor(manager, session).check()).toBe(false)
    expect(data.has('auth:user_id')).toBe(false)
  })

  it('reads the user once per request', async () => {
    seed(`${CURRENT_FORMAT}secret`)
    const manager = wireAuth()
    const { session } = memorySession()
    await requestFor(manager, session).attempt(credentials)
    User.find.mockClear()

    const next = requestFor(manager, session)
    await next.check()
    await next.user()
    await next.id()

    expect(User.find).toHaveBeenCalledTimes(1)
  })

  it('keeps the credential columns out of user()', async () => {
    seed(`${CURRENT_FORMAT}secret`)
    const manager = wireAuth()
    const { session } = memorySession()
    const login = requestFor(manager, session)
    await login.attempt(credentials)

    for (const guard of [login, requestFor(manager, session)]) {
      const user = await guard.user<Record<string, unknown>>()
      expect(user).toMatchObject({ id: 1, email: 'ada@example.com' })
      expect(user).not.toHaveProperty('passwordHash')
      expect(user).not.toHaveProperty('rememberToken')
    }
  })

  it('forgets the stamp on logout', async () => {
    seed(`${CURRENT_FORMAT}secret`)
    const manager = wireAuth()
    const { data, session } = memorySession()
    const guard = requestFor(manager, session)
    await guard.attempt(credentials)

    await guard.logout()

    expect(await guard.check()).toBe(false)
    expect(data.has('auth:password_stamp')).toBe(false)
  })

  it('refuses to log in a record without its password hash', async () => {
    const manager = wireAuth()
    const { session } = memorySession()

    await expect(requestFor(manager, session).login({ id: 1, email: 'ada@example.com' })).rejects.toThrow(
      'passwordHash',
    )
  })
})
