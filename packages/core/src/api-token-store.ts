import { Model, type PlainObject } from '@guren/orm'
import type { ApiToken, ApiTokenStore } from '@guren/server'
import { decodeJsonColumn, toDate, toOptionalExpiry } from './store-utils.js'

export interface DatabaseApiTokenStoreOptions {
  /**
   * How the `abilities` column stores the ability list.
   *
   * - `'json'` (default) passes the array straight through — use with a
   *   JSON-capable column (pg `jsonb`/`json`, sqlite `text(..., { mode: 'json' })`).
   * - `'text'` serializes to a JSON string for plain text columns.
   *
   * Reads always accept both representations.
   * @default 'json'
   */
  abilitiesMode?: 'json' | 'text'
}

/**
 * Database-backed API token store built on the Guren ORM.
 *
 * Pass the Drizzle table for your `api_tokens` schema; its column property
 * names must match the {@link ApiToken} fields. The ORM must be configured
 * before the store is used.
 *
 * @example `new DatabaseApiTokenStore(apiTokens)`
 */
export class DatabaseApiTokenStore implements ApiTokenStore {
  private readonly model: typeof Model
  private readonly abilitiesMode: 'json' | 'text'

  constructor(table: unknown, options: DatabaseApiTokenStoreOptions = {}) {
    this.abilitiesMode = options.abilitiesMode ?? 'json'
    this.model = class ApiTokenModel extends Model {
      static override table = table
    }
  }

  async store(token: ApiToken): Promise<void> {
    await this.model.forceCreate({
      ...token,
      abilities:
        this.abilitiesMode === 'text' ? JSON.stringify(token.abilities) : token.abilities,
    })
  }

  async findByHashedToken(hashedToken: string): Promise<ApiToken | null> {
    const record = await this.model.where({ hashedToken }).first()
    return record ? this.deserialize(record) : null
  }

  async findByUserId(userId: string | number): Promise<ApiToken[]> {
    const records = await this.model.where({ userId }).get()
    return records.map((record) => this.deserialize(record))
  }

  async delete(id: string): Promise<void> {
    await this.model.where({ id }).delete()
  }

  async deleteForUser(userId: string | number): Promise<void> {
    await this.model.where({ userId }).delete()
  }

  async updateLastUsed(id: string, timestamp: Date): Promise<void> {
    await this.model.forceUpdate({ id }, { lastUsedAt: timestamp })
  }

  /**
   * Delete tokens whose expiration has passed. `verifyApiToken` already rejects
   * them; this only keeps the table small.
   */
  async deleteExpired(now: Date = new Date()): Promise<void> {
    await this.model.where('expiresAt', '<', now).delete()
  }

  // Not replaceable with `static casts`: QueryBuilder reads (`where().first()/.get()`)
  // bypass model casts, and cast-based writes would fight drizzle column modes
  // (Date → ISO string breaks timestamp columns; json-stringify double-encodes jsonb).
  private deserialize(record: PlainObject): ApiToken {
    const abilities = decodeJsonColumn<unknown>(record.abilities, [])
    return {
      id: String(record.id),
      name: String(record.name),
      hashedToken: String(record.hashedToken),
      userId:
        typeof record.userId === 'bigint' ? record.userId.toString() : (record.userId as string | number),
      // Deny-by-default on corrupt text, and on anything that is not a list of
      // strings: `tokenCan` would otherwise run `String.prototype.includes`, so
      // a stored `'"*"'` would grant every ability.
      abilities: Array.isArray(abilities)
        ? abilities.filter((ability): ability is string => typeof ability === 'string')
        : [],
      lastUsedAt: toDate(record.lastUsedAt),
      // Null means "never expires" (`verifyApiToken` skips its expiry check), so
      // an unparseable value must not degrade to it.
      expiresAt: toOptionalExpiry(record.expiresAt),
      createdAt: toDate(record.createdAt) ?? new Date(0),
    }
  }
}
