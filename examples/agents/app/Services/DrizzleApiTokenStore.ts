/**
 * `ApiTokenStore` over a table. The framework's `MemoryApiTokenStore` (what
 * `examples/api` uses) cannot serve Workers: each request may land on a
 * different isolate, so a token minted by the seeder would be unknown to the
 * one that answers.
 */
import type { ApiToken, ApiTokenStore } from '@guren/core'

import { ApiTokenRecord } from '../Models/ApiTokenRecord'

export class DrizzleApiTokenStore implements ApiTokenStore {
  /** `forceCreate`: the record comes from `createApiToken`, never from a request. */
  async store(token: ApiToken): Promise<void> {
    await ApiTokenRecord.forceCreate({
      id: token.id,
      name: token.name,
      hashedToken: token.hashedToken,
      userId: Number(token.userId),
      abilities: token.abilities,
      lastUsedAt: token.lastUsedAt,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    })
  }

  /** The columns are the interface's fields, so a row is already an `ApiToken`. */
  async findByHashedToken(hashedToken: string): Promise<ApiToken | null> {
    const rows = (await ApiTokenRecord.where('hashedToken', hashedToken).limit(1).get()) as ApiToken[]
    return rows[0] ?? null
  }

  async findByUserId(userId: string | number): Promise<ApiToken[]> {
    return (await ApiTokenRecord.where('userId', Number(userId)).get()) as ApiToken[]
  }

  async delete(id: string): Promise<void> {
    await ApiTokenRecord.where('id', id).delete()
  }

  async deleteForUser(userId: string | number): Promise<void> {
    await ApiTokenRecord.where('userId', Number(userId)).delete()
  }

  async updateLastUsed(id: string, timestamp: Date): Promise<void> {
    await ApiTokenRecord.where('id', id).forceUpdate({ lastUsedAt: timestamp })
  }
}

export const apiTokenStore = new DrizzleApiTokenStore()
