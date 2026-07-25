import { Model } from '@guren/orm'
import type { OAuthStatePayload, OAuthStateStore } from '@guren/server'
import { isExpired, toDate } from './store-utils.js'

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
   * Atomically fetch and delete a state, guaranteeing exactly one concurrent
   * caller for the same hash receives the payload.
   *
   * This guarantee depends on the configured ORM adapter's `delete()`
   * reporting whether a row actually matched — either the deleted row
   * (RETURNING) or an affected-row count. `DrizzleAdapter`, the framework's
   * default and only shipped adapter, always does this: RETURNING drivers
   * (Postgres, SQLite, D1) resolve to the deleted row or `undefined` only
   * when zero rows matched; MySQL resolves to a result carrying
   * `affectedRows` (verified by inspection, not a dedicated test).
   *
   * The `ORMAdapter.delete` contract also permits a bare `void` return.
   * A custom adapter (via `Model.useAdapter()`) that returns `void`
   * unconditionally — on both a successful delete and a no-op — gives
   * `consume()` no way to tell which caller won: the value is identical for
   * both, so no post-hoc check can attribute the deletion. Rather than
   * silently rejecting every real login for such adapters,
   * `deleteRemovedRow` treats an unrecognized non-null result as removed —
   * this reopens the pre-consume find-then-delete race window (multiple
   * concurrent callers can pass) for adapters that can't report a match,
   * but does not break login. It is fail-closed (returns null / rejects)
   * only for `null`/`undefined`, DrizzleAdapter's definitive "no rows
   * matched" signal.
   */
  async consume(stateHash: string): Promise<OAuthStatePayload | null> {
    const record = await this.model.where({ stateHash }).first()
    if (!record) {
      return null
    }

    if (isExpired(record.expiresAt)) {
      await this.model.where({ stateHash, expiresAt: record.expiresAt }).delete()
      return null
    }

    // Guarded delete on the observed row version: only the caller whose
    // DELETE actually removes the row may return the payload. RETURNING
    // drivers (postgres, sqlite, d1) yield the deleted row or undefined;
    // MySQL yields a result carrying affectedRows — both distinguish the
    // winner from concurrent losers.
    const result = await this.model.where({ stateHash, expiresAt: record.expiresAt }).delete()
    if (!deleteRemovedRow(result)) {
      return null
    }

    return {
      provider: String(record.provider),
      redirectTo: record.redirectTo == null ? undefined : String(record.redirectTo),
      // isExpired above guarantees this parses.
      expiresAt: toDate(record.expiresAt) as Date,
    }
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

/**
 * Interpret an adapter delete result as "this call removed the row". See
 * the `consume()` JSDoc above for the full adapter-support tradeoff: this
 * is exact for DrizzleAdapter, and best-effort (assume removed) for any
 * other result shape, since a bare `void` return carries no information to
 * confirm or refute a match.
 */
function deleteRemovedRow(result: unknown): boolean {
  if (result == null) return false
  if (typeof result === 'number') return result > 0
  if (Array.isArray(result)) {
    // mysql2 resolves to [ResultSetHeader, fields]
    return result.length > 0 && deleteRemovedRow(result[0])
  }
  if (typeof result === 'object') {
    const record = result as Record<string, unknown>
    for (const key of ['affectedRows', 'rowsAffected', 'rowCount', 'changes'] as const) {
      if (typeof record[key] === 'number') return (record[key] as number) > 0
    }
    // No count field: assume this is the deleted row itself (RETURNING).
    return true
  }
  return Boolean(result)
}
