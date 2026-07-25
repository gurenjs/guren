import { Model } from '@guren/orm'
import type { OAuthStatePayload, OAuthStateStore } from '@guren/server'
import { isExpired, toDate } from './store-utils'

/**
 * Database-backed OAuth state store built on the Guren ORM.
 *
 * The default `MemoryOAuthStateStore` keeps state in per-isolate memory,
 * which breaks on serverless: the OAuth authorize redirect and the callback
 * that follows it can land on different instances, so an in-memory map
 * never sees the state that was just written. Backing the store with the
 * database makes state visible to whichever instance handles the callback.
 *
 * Pass the Drizzle table for your `oauth_states` schema. Column property
 * names must match `stateHash` (text primary key), `provider`,
 * `redirectTo`, and `expiresAt`:
 *
 * ```ts
 * export const oauthStates = sqliteTable('oauth_states', {
 *   stateHash: text('state_hash').primaryKey(),
 *   provider: text('provider').notNull(),
 *   redirectTo: text('redirect_to'),
 *   expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
 * })
 * ```
 *
 * @example
 * ```ts
 * import { createOAuthManager, DatabaseOAuthStateStore } from '@guren/core'
 * import { oauthStates } from '@/db/schema'
 *
 * export const oauth = createOAuthManager({
 *   stateStore: new DatabaseOAuthStateStore(oauthStates),
 * })
 * ```
 */
export class DatabaseOAuthStateStore implements OAuthStateStore {
  private readonly model: typeof Model

  constructor(table: unknown) {
    this.model = class OAuthStateModel extends Model {
      static override table = table
    }
  }

  async store(stateHash: string, payload: OAuthStatePayload): Promise<void> {
    await this.model.forceCreate({
      stateHash,
      provider: payload.provider,
      redirectTo: payload.redirectTo ?? null,
      expiresAt: payload.expiresAt,
    })
  }

  async find(stateHash: string): Promise<OAuthStatePayload | null> {
    const record = await this.model.where({ stateHash }).first()
    if (!record) {
      return null
    }

    if (isExpired(record.expiresAt)) {
      // Delete only the observed row version (raw value equality binds
      // portably across column modes), so a concurrent re-issue of the same
      // hash cannot be deleted out from under its request.
      await this.model.where({ stateHash, expiresAt: record.expiresAt }).delete()
      return null
    }

    return {
      provider: String(record.provider),
      redirectTo: record.redirectTo == null ? undefined : String(record.redirectTo),
      // isExpired above guarantees this parses.
      expiresAt: toDate(record.expiresAt) as Date,
    }
  }

  async delete(stateHash: string): Promise<void> {
    await this.model.where({ stateHash }).delete()
  }

  /**
   * Delete OAuth states whose expiration time has passed. Expired states
   * are already rejected by `find`; call this from a scheduled job to keep
   * the table small.
   */
  async deleteExpired(now: Date = new Date()): Promise<void> {
    await this.model.where('expiresAt', '<=', now).delete()
  }
}
