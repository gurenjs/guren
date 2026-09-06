import { createApiToken } from '@guren/core'
import { defineSeeder } from '@guren/orm'
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite'

import { apiTokenStore } from '../../app/Services/DrizzleApiTokenStore'
import { configureOrm } from '../../config/database'
import { OPERATOR, demoTickets } from '../fixtures'
import { tickets, users } from '../schema'

/**
 * `defineSeeder` defaults its database type to Postgres, so a sqlite app has to
 * name its own — and `@guren/orm/drizzle/sqlite` re-exports `sqlite-core`,
 * which does not carry the database types. Hence the direct drizzle import.
 * Seeders run on Bun only; D1's rows come from `db/seed-d1.ts`.
 */
export default defineSeeder<SQLiteBunDatabase>(async ({ db }) => {
  // `guren db:seed` calls `seedDatabase()` without booting the app, so nothing
  // else has pointed the models at this connection. Idempotent, so the
  // in-process path (`bootModels`) is unaffected.
  await configureOrm()

  await db.insert(users).values([OPERATOR]).onConflictDoNothing({ target: users.email })
  const [operator] = await db.select().from(users).limit(1)

  // Re-runnable: a second `db:seed` must not stack duplicate tickets or mint a
  // second live token. Only the first run has a plaintext to print.
  if ((await db.select().from(tickets).limit(1)).length === 0) {
    await db.insert(tickets).values(demoTickets())
  }
  if ((await apiTokenStore.findByUserId(operator!.id)).length > 0) {
    console.log('Already seeded; the operator token was printed by the first run.')
    return
  }

  const { plainTextToken } = await createApiToken(apiTokenStore, {
    name: 'operator-cli',
    userId: operator!.id,
  })

  // The only time the plaintext exists. `hashed_token` is all the row keeps.
  console.log(`Operator API token (shown once): ${plainTextToken}`)
})
