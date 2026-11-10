import { createHash, timingSafeEqual } from 'node:crypto'
import { SessionGuard } from '@guren/core'
import type { AuthCredentials, Authenticatable, UserProvider } from '@guren/core'

export type PasswordBoundSessionGuardOptions = ConstructorParameters<typeof SessionGuard>[0] & {
  /** The column the user provider reads the password hash from. */
  passwordColumn: string
}

// A digest of the hash, so the hash itself never reaches the session store.
const STAMP_KEY = 'auth:password_stamp'

function passwordHashOf(record: unknown, column: string): string | null {
  const value = (record as Record<string, unknown> | null | undefined)?.[column]
  return typeof value === 'string' ? value : null
}

function stampOf(record: unknown, column: string): string | null {
  const hash = passwordHashOf(record, column)
  return hash === null ? null : createHash('sha256').update(hash).digest('base64url')
}

function sameStamp(stored: unknown, current: string | null): boolean {
  if (typeof stored !== 'string' || current === null) return false
  const a = Buffer.from(stored)
  const b = Buffer.from(current)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A session guard whose sessions end once the account's password hash changes
 * (a reset, a profile update), so a session opened before the change stops
 * authenticating at its next request.
 */
export class PasswordBoundSessionGuard<User extends Authenticatable = Authenticatable> extends SessionGuard<User> {
  private readonly users: UserProvider<User>
  private readonly passwordColumn: string
  private readonly lastRead: { row: User | null | undefined }
  private verdict: boolean | undefined

  constructor({ passwordColumn, ...options }: PasswordBoundSessionGuardOptions) {
    const users = options.provider as UserProvider<User>
    const lastRead: { row: User | null | undefined } = { row: undefined }
    // Keeps the row the parent resolves the session's user from, so the stamp
    // check needs no second query. Prototype delegation keeps every other method.
    const recording = Object.create(users) as UserProvider<User>
    recording.retrieveById = async (identifier) => {
      lastRead.row = await users.retrieveById(identifier)
      return lastRead.row
    }
    super({ ...options, provider: recording })
    this.users = users
    this.passwordColumn = passwordColumn
    this.lastRead = lastRead
  }

  override async check(): Promise<boolean> {
    this.verdict ??= await this.confirm()
    return this.verdict
  }

  override async user<T = User>(): Promise<T | null> {
    return (await this.check()) ? super.user<T>() : null
  }

  override async id(): Promise<unknown> {
    return (await this.check()) ? super.id() : null
  }

  override async validate(credentials: AuthCredentials): Promise<User | null> {
    const user = await super.validate(credentials)
    if (!user) return null
    // The parent's rehash changes the hash on `user` before its write, and a
    // failed write does not fail the login, so read back what the store holds.
    const row = await this.users.retrieveById(this.users.getId(user))
    if (!row) return null
    if (passwordHashOf(row, this.passwordColumn) === passwordHashOf(user, this.passwordColumn)) return row
    // A failed rehash write leaves a hash these credentials still verify against;
    // a reset that overtook this login leaves one they do not.
    return (await this.users.validateCredentials(row, credentials)) ? row : null
  }

  override async login<T = User>(user: T, remember = false): Promise<void> {
    const stamp = stampOf(user, this.passwordColumn)
    if (stamp === null) {
      throw new Error(`PasswordBoundSessionGuard: login() needs the user record with its "${this.passwordColumn}" column.`)
    }
    await super.login(user, remember)
    this.session()?.set(STAMP_KEY, stamp)
    this.verdict = true
  }

  override async logout(): Promise<void> {
    await super.logout()
    this.session()?.forget(STAMP_KEY)
    this.verdict = undefined
  }

  private async confirm(): Promise<boolean> {
    const user = await super.user<User>()
    if (!user) return false
    const id = this.users.getId(user)
    const read = this.lastRead.row
    const row = read && this.users.getId(read) === id ? read : await this.users.retrieveById(id)
    // A session from before this guard carries no stamp and is signed out too:
    // nothing shows it was opened under the current password.
    if (sameStamp(this.session()?.get(STAMP_KEY), stampOf(row, this.passwordColumn))) return true
    await this.logout()
    return false
  }
}
