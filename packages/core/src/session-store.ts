import { Model, type PlainObject } from '@guren/orm'
import type { SessionData, SessionStore } from '@guren/server'
import { decodeJsonColumn, isExpired } from './store-utils.js'

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
 * Database-backed session store built on the Guren ORM — the serverless default:
 * no Redis on Lambda, Vercel, or Workers, and reads are strongly consistent.
 *
 * Pass the Drizzle table for your `sessions` schema; column property names must
 * be `id` (text primary key), `data`, and `expiresAt`.
 *
 * Session values must be JSON-serializable, unlike `MemorySessionStore` which
 * keeps live references: Dates come back as ISO strings, `undefined` properties
 * are dropped, and `bigint` fails to serialize.
 *
 * @example `new DatabaseSessionStore(sessions)`
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

    if (isExpired(record.expiresAt)) {
      // Only the observed row version, so a concurrent request that just
      // refreshed this id does not lose its fresh session.
      await this.model.where({ id, expiresAt: record.expiresAt }).delete()
      return undefined
    }

    return this.deserialize(record)
  }

  async write(id: string, data: SessionData, ttlSeconds: number): Promise<void> {
    const payload = {
      data: this.dataMode === 'text' ? JSON.stringify(data) : data,
      expiresAt: this.expiryDate(ttlSeconds),
    }

    const existing = await this.model.where({ id }).first()
    if (existing) {
      await this.model.forceUpdate({ id }, payload)
      return
    }

    try {
      await this.model.forceCreate({ id, ...payload })
    } catch (error) {
      // Only a lost concurrent-create race leaves the row present; any other
      // insert failure must propagate rather than "succeed" via a zero-row
      // update. Dialect error shapes are not normalized, so existence is the
      // portable discriminator.
      const nowExists = await this.model.where({ id }).first()
      if (!nowExists) {
        throw error
      }
      await this.model.forceUpdate({ id }, payload)
    }
  }

  async destroy(id: string): Promise<void> {
    await this.model.where({ id }).delete()
  }

  /**
   * Refresh an existing session's TTL with one conditional UPDATE. Missing and
   * already-expired rows are left untouched, never resurrected, per the
   * `SessionStore.touch` contract.
   */
  async touch(id: string, ttlSeconds: number): Promise<void> {
    await this.model
      .where({ id })
      .where('expiresAt', '>', new Date())
      .forceUpdate({ expiresAt: this.expiryDate(ttlSeconds) })
  }

  /**
   * Delete sessions whose expiration has passed. `read` already treats them as
   * missing; this only keeps the table small.
   */
  async deleteExpired(now: Date = new Date()): Promise<void> {
    await this.model.where('expiresAt', '<=', now).delete()
  }

  private deserialize(record: PlainObject): SessionData {
    return decodeJsonColumn<SessionData>(record.data, {})
  }

  private expiryDate(ttlSeconds: number): Date {
    return new Date(Date.now() + ttlSeconds * 1000)
  }
}
