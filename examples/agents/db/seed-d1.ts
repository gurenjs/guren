/**
 * Render the demo fixtures as SQL for `wrangler d1 execute`.
 *
 * `db/seeders/*` runs on Bun against bun:sqlite; D1's local store is inside
 * miniflare, where neither the seeder runner nor the ORM can reach it. The
 * rows and the token come from the same code either way — the plaintext token
 * exists only in this run's stderr.
 */
import { createApiToken } from '@guren/core'
import type { ApiToken, ApiTokenStore } from '@guren/core'

import { OPERATOR, demoTickets } from './fixtures'

/** Captures the minted token instead of storing it; the rest is never called. */
class CollectingTokenStore implements ApiTokenStore {
  minted: ApiToken | undefined

  async store(token: ApiToken): Promise<void> {
    this.minted = token
  }

  async findByHashedToken(): Promise<ApiToken | null> {
    return null
  }

  async findByUserId(): Promise<ApiToken[]> {
    return []
  }

  async delete(): Promise<void> {}

  async deleteForUser(): Promise<void> {}

  async updateLastUsed(): Promise<void> {}
}

function quote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`
}

const collector = new CollectingTokenStore()
const { plainTextToken } = await createApiToken(collector, { name: 'operator-cli', userId: 1 })
const token = collector.minted!

const statements = [
  `INSERT INTO users (id, name, email, created_at) VALUES (1, ${quote(OPERATOR.name)}, ${quote(OPERATOR.email)}, ${Date.now()});`,
  `INSERT INTO api_tokens (id, name, hashed_token, user_id, abilities, last_used_at, expires_at, created_at) VALUES (${quote(token.id)}, ${quote(token.name)}, ${quote(token.hashedToken)}, 1, ${quote(JSON.stringify(token.abilities))}, NULL, NULL, ${token.createdAt.getTime()});`,
  ...demoTickets().map(
    (ticket) =>
      `INSERT INTO tickets (title, status, created_at, updated_at) VALUES (${quote(ticket.title)}, ${quote(ticket.status)}, ${ticket.createdAt.getTime()}, ${ticket.updatedAt.getTime()});`,
  ),
]

console.log(statements.join('\n'))
console.error(`Operator API token (shown once): ${plainTextToken}`)
