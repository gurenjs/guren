import { Model, type PlainObject } from '@guren/orm'
import type { SessionData, SessionStore } from '@guren/server'
import { toDate } from './store-utils'

/**
 * Options for DatabaseSessionStore.
 */
export interface DatabaseSessionStoreOptions {
  /**
   * How the `data` column stores the serialized session.
   *
   * - `'json'` (default) passes the object straight through — use with a
   *   JSON-capable column (pg `jsonb`/`json`, sqlite `text(..., { mode: 'json' })`).
   * - `'text'` serializes to a JSON string for plain text columns.
   *
   * Reads always accept both representations.
   * @default 'json'
   */
  dataMode?: 'json' | 'text'
}

/**
 * Database-backed session store built on the Guren ORM — works on any
 * configured connection (SQLite, Postgres, MySQL, or Cloudflare D1), which
 * makes it the serverless default: no Redis required on Lambda, Vercel, or
 * Workers, and reads are strongly consistent (login → redirect → read works).
 *
 * Pass the Drizzle table for your `sessions` schema. Column property names
 * must match `id` (text primary key), `data`, and `expiresAt`:
 *
 * ```ts
 * export const sessions = sqliteTable('sessions', {
 *   id: text('id').primaryKey(),
 *   data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
 *   expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
 * })
 * ```
 *
 * @example
 * ```ts
 * import { DatabaseSessionStore } from '@guren/core'
 * import { sessions } from '@/db/schema'
 *
 * app.use(createSessionMiddleware({ store: new DatabaseSessionStore(sessions) }))
 * ```
 */
export class DatabaseSessionStore implements SessionStore {
  private readonly model: typeof Model
  private readonly dataMode: 'json' | 'text'

  constructor(table: unknown, options: DatabaseSessionStoreOptions = {}) {
    this.dataMode = options.dataMode ?? 'json'
    this.model = class SessionModel extends Model {
      static override table = table
    }
  }

  async read(id: string): Promise<SessionData | undefined> {
    const record = await this.model.where({ id }).first()
    if (!record) {
      return undefined
    }

    const expiresAt = toDate(record.expiresAt)
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      await this.destroy(id)
      return undefined
    }

    return this.deserialize(record)
  }

  async write(id: string, data: SessionData, ttlSeconds: number): Promise<void> {
    const payload = {
      data: this.dataMode === 'text' ? JSON.stringify(data) : data,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    }

    const existing = await this.model.where({ id }).first()
    if (existing) {
      await this.model.forceUpdate({ id }, payload)
      return
    }

    try {
      await this.model.forceCreate({ id, ...payload })
    } catch {
      // Lost a concurrent-create race on the primary key — the row exists
      // now, so converge on an update.
      await this.model.forceUpdate({ id }, payload)
    }
  }

  async destroy(id: string): Promise<void> {
    await this.model.where({ id }).delete()
  }

  /**
   * Delete sessions whose expiration time has passed. Expired rows are
   * already treated as missing (and removed) by `read`; call this from a
   * scheduled job to keep the table small.
   */
  async deleteExpired(now: Date = new Date()): Promise<void> {
    await this.model.where('expiresAt', '<', now).delete()
  }

  private deserialize(record: PlainObject): SessionData {
    const data = record.data
    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as SessionData
      } catch {
        return {}
      }
    }
    return (data ?? {}) as SessionData
  }
}
