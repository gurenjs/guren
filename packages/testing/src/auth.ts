/**
 * Common test utilities for authentication-related tests.
 */

export interface MockUser {
  id: number
  email: string
  password: string
  emailVerifiedAt?: Date | null
  getAuthIdentifier(): number
  getAuthPassword(): string
}

export interface MockUserProvider<T extends MockUser = MockUser> {
  retrieveById: (id: unknown) => Promise<T | null>
  retrieveByCredentials: (credentials: Record<string, unknown>) => Promise<T | null>
  validateCredentials: (user: T, credentials: Record<string, unknown>) => Promise<boolean>
  getId: (user: T) => unknown
}

export interface MockAuthContext<User = { id: number; name: string }> {
  check: () => Promise<boolean>
  guest: () => Promise<boolean>
  user: <T = User>() => Promise<T | null>
  userOrFail: <T = User>() => Promise<T>
  id: () => Promise<unknown>
  login: <T = User>(user: T, remember?: boolean) => Promise<void>
  logout: () => Promise<void>
  attempt: (credentials: Record<string, unknown>, remember?: boolean) => Promise<boolean>
  guard: <T = User>(name?: string) => any
  session: <T = unknown>() => T | undefined
}

/**
 * Creates a mock user with Authenticatable interface.
 */
export function createMockUser(data: {
  id: number
  email: string
  password: string
  emailVerifiedAt?: Date | null
}): MockUser {
  return {
    ...data,
    getAuthIdentifier() {
      return this.id
    },
    getAuthPassword() {
      return this.password
    },
  }
}

/**
 * Creates a mock user provider for auth tests.
 */
export function createMockProvider<T extends MockUser>(users: T[]): MockUserProvider<T> {
  return {
    retrieveById: async (id) => users.find((u) => u.id === id) ?? null,
    retrieveByCredentials: async (credentials) => {
      return users.find((u) => u.email === credentials.email) ?? null
    },
    validateCredentials: async (user, credentials) => {
      return user.password === credentials.password
    },
    getId: (user) => user.id,
  }
}

/**
 * Creates a mock auth context for middleware tests.
 */
export function createMockAuthContext(options: {
  isAuthenticated: boolean
  user?: { id: number; name: string }
}): MockAuthContext {
  const defaultUser = { id: 1, name: 'Test User' }
  const user = options.user ?? defaultUser

  return {
    check: async () => options.isAuthenticated,
    guest: async () => !options.isAuthenticated,
    user: async <T = typeof user>() => (options.isAuthenticated ? (user as T) : null),
    userOrFail: async <T = typeof user>() => {
      if (!options.isAuthenticated) throw new Error('Unauthenticated.')
      return user as T
    },
    id: async () => (options.isAuthenticated ? user.id : null),
    login: async <_T = typeof user>(_userValue: _T, _remember?: boolean) => {},
    logout: async () => {},
    attempt: async (_credentials: Record<string, unknown>, _remember?: boolean) => false,
    guard: <_T = typeof user>(_name?: string) => ({}),
    session: <_T = unknown>() => undefined,
  }
}
