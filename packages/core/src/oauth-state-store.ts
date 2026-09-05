import { Model } from '@guren/orm'
import type { OAuthStatePayload, OAuthStateStore } from '@guren/server'
import { isExpired, toDate } from './store-utils.js'

/**
 * Database-backed OAuth state store built on the Guren ORM, for serverless, where
 * authorize and callback can land on different instances. Column property names
 * of the `oauth_states` table must be `stateHash` (text primary key), `provider`,
 * `redirectTo`, `expiresAt`, and `binding` (else `authorize({ bindTo })` states come back unbound).
 * @example `new DatabaseOAuthStateStore(oauthStates)`
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
      // Persisted, not derived: an unbound state verifies for any browser.
      binding: payload.binding ?? null,
    })
  }

  async find(stateHash: string): Promise<OAuthStatePayload | null> {
    const record = await this.fetchLive(stateHash)
    return record ? mapRecordToPayload(record) : null
  }

  /** Fetch the row for `stateHash`, clearing it and returning null if expired. */
  private async fetchLive(stateHash: string): Promise<Record<string, unknown> | null> {
    const record = await this.model.where({ stateHash }).first()
    if (!record) {
      return null
    }

    if (isExpired(record.expiresAt)) {
      // Only the observed row version, so a concurrent re-issue of the same hash
      // is not deleted out from under its request.
      await this.model.where({ stateHash, expiresAt: record.expiresAt }).delete()
      return null
    }

    return record
  }

  async delete(stateHash: string): Promise<void> {
    await this.model.where({ stateHash }).delete()
  }

  /**
   * Atomically fetch and delete a state, so exactly one concurrent caller for a
   * hash receives the payload. Relies on `delete()` reporting a match
   * (`DrizzleAdapter`: RETURNING row, or MySQL `affectedRows`). An adapter
   * returning bare `void` reopens the find-then-delete race: `deleteRemovedRow`
   * fails closed only on `null`/`undefined`, Drizzle's definitive "no rows matched".
   */
  async consume(stateHash: string): Promise<OAuthStatePayload | null> {
    const record = await this.fetchLive(stateHash)
    if (!record) {
      return null
    }

    // Only the caller whose DELETE actually removes the row may return the
    // payload. The pre-delete read above is what supplies that payload on MySQL,
    // which has no RETURNING to read it back from the delete itself.
    const result = await this.model.where({ stateHash, expiresAt: record.expiresAt }).delete()
    return deleteRemovedRow(result) ? mapRecordToPayload(record) : null
  }

  /**
   * Delete states whose expiration has passed. `find` already rejects them; this
   * only keeps the table small.
   */
  async deleteExpired(now: Date = new Date()): Promise<void> {
    await this.model.where('expiresAt', '<=', now).delete()
  }
}

/** Build the public payload from a live (non-expired) row. */
function mapRecordToPayload(record: Record<string, unknown>): OAuthStatePayload {
  return {
    provider: String(record.provider),
    redirectTo: record.redirectTo == null ? undefined : String(record.redirectTo),
    // fetchLive's isExpired check guarantees this parses.
    expiresAt: toDate(record.expiresAt) as Date,
    binding: record.binding == null ? undefined : String(record.binding),
  }
}

/**
 * Interpret an adapter delete result as "this call removed the row": exact for
 * DrizzleAdapter, assume-removed for any other shape (see `consume()`).
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
